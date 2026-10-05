import { runningResult, finalizeExecResult } from "./result-presentation.js";
import { retainedOutputFailure } from "./retained-output-failure.js";
import { ExecRequestResources } from "./request-resources.js";
import {
  boundText,
  readBoundedInteger,
  readRequiredString,
  type RuntimePluginLoadContext,
  type ToolRequestPreparationContext,
  type ToolExecutionContext,
  type ToolImplementation,
  type ToolImplementationOutput,
} from "../../../src/plugin-sdk/index.js";

import { execFailureFromError, ExecPluginError } from "./errors.js";
import { captureExecFilesystemSnapshot } from "./filesystem-observer.js";
import { resolveExecWorkingDirectory } from "./paths.js";
import { createExecProcessManager } from "./process-manager.js";
import { createExecOutputStore } from "./output-store.js";
import { materializeExecOutput } from "./output-snapshot.js";
import type { ExecSettings } from "./settings.js";
import type { ExecProcessSnapshot, PendingExecExecution } from "./types.js";
import { readExecCommand } from "./validation.js";

const COMMAND_PREVIEW_MAX_CHARS = 768;

function processScope(context: ToolExecutionContext | undefined): string {
  const sessionId = context?.sharedState?.currentSessionId?.trim();
  return sessionId || "anonymous";
}

type ExecHandlers = Readonly<{
  exec: ToolImplementation;
  exec_wait: ToolImplementation;
  exec_cancel: ToolImplementation;
}>;

export function createExecHandlers(
  pluginContext: RuntimePluginLoadContext,
  settings: ExecSettings,
  preparation?: ToolRequestPreparationContext,
): ExecHandlers {
  const outputStore = createExecOutputStore({
    stateDir: pluginContext.stateDir,
    retentionMs: settings.outputRetentionMs,
  });
  outputStore.startMaintenance();
  const processManager = createExecProcessManager(outputStore);
  const pendingExecutions = new Map<string, PendingExecExecution>();
  const requestResources = new ExecRequestResources(
    processManager,
    pendingExecutions,
    preparation,
  );

  const finalizeAndRelease = async (params: {
    snapshot: ExecProcessSnapshot;
    execution: PendingExecExecution;
    scope: string;
    cancellationIsSuccess?: boolean;
    context?: ToolExecutionContext;
  }): Promise<ToolImplementationOutput> => {
    pendingExecutions.set(params.snapshot.processId, params.execution);
    try {
      if (params.snapshot.outputFailure) {
        return retainedOutputFailure(params.snapshot, params.context);
      }
      const result = await finalizeExecResult({
        ...params,
        resultBudget: params.context?.resultBudget,
      });
      if (result.errorCode === "plugin_result_too_large") {
        return retainedOutputFailure(params.snapshot, params.context);
      }
      try {
        if (!requestResources.isRestored(params.snapshot.processId)) {
          await processManager.accept(params.snapshot, params.scope);
        }
      } catch (error) {
        return retainedOutputFailure(
          {
            ...params.snapshot,
            outputFailure: {
              code:
                error instanceof Error
                  ? error.message
                  : "exec_output_acknowledgement_failed",
              stdoutBytes: params.snapshot.stdout.body?.byteLength ?? 0,
              stderrBytes: params.snapshot.stderr.body?.byteLength ?? 0,
            },
          },
          params.context,
        );
      }
      pendingExecutions.delete(params.snapshot.processId);
      requestResources.forget(params.snapshot.processId);
      await processManager.release(params.snapshot.processId, params.scope);
      return result;
    } finally {
      requestResources.rejectTerminal(params.snapshot);
      await processManager.reject(params.snapshot, params.scope);
    }
  };

  const deliverRunning = async (
    snapshot: ExecProcessSnapshot,
    execution: PendingExecExecution,
    scope: string,
    context?: ToolExecutionContext,
  ): Promise<ToolImplementationOutput> => {
    if (snapshot.outputFailure) return retainedOutputFailure(snapshot, context);
    const result = runningResult(snapshot, execution, context?.resultBudget);
    if (result.errorCode === "plugin_result_too_large") {
      return retainedOutputFailure(snapshot, context);
    }
    await processManager.accept(snapshot, scope);
    return result;
  };

  const exec: ToolImplementation = async (params, context) => {
    try {
      const command = readExecCommand(params.command);
      const cwd = await resolveExecWorkingDirectory(
        pluginContext,
        context,
        params.cwd,
      );
      const filesystemStateBefore = await captureExecFilesystemSnapshot(
        cwd.absolutePath,
        cwd.logicalPath,
      ).catch(() => null);
      const commandPreview = boundText(command, {
        maxChars: COMMAND_PREVIEW_MAX_CHARS,
        marker: "\n[command preview truncated]",
      }).text;
      const execution: PendingExecExecution = Object.freeze({
        commandPreview,
        cwd,
        filesystemStateBefore,
        hardTimeoutMs: settings.hardTimeoutMs,
        idleTimeoutMs: Math.min(settings.idleTimeoutMs, settings.hardTimeoutMs),
      });
      const scope = processScope(context);
      const snapshot = await processManager.start({
        scope,
        shellCommand: command,
        cwd: cwd.absolutePath,
        yieldAfterMs: Math.min(settings.yieldAfterMs, settings.hardTimeoutMs),
        idleTimeoutMs: execution.idleTimeoutMs,
        hardTimeoutMs: execution.hardTimeoutMs,
        ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
        onDisposed: (processId) => {
          pendingExecutions.delete(processId);
          requestResources.forget(processId);
        },
        onStarted: (processId, settled) =>
          requestResources.started(processId, scope, settled, context),
      });
      if (snapshot.status === "running") {
        pendingExecutions.set(snapshot.processId, execution);
        return deliverRunning(snapshot, execution, scope, context);
      }
      return finalizeAndRelease({ snapshot, execution, scope, context });
    } catch (error) {
      return execFailureFromError(error, "exec");
    }
  };

  const execWait: ToolImplementation = async (params, context) => {
    try {
      const processId = readRequiredString(params.process_id, {
        name: "process_id",
        maxLength: 128,
      });
      const cursor = readBoundedInteger(params.cursor, {
        name: "cursor",
        minimum: 1,
        maximum: 1_000_000,
      });
      const execution = pendingExecutions.get(processId);
      if (!execution) {
        throw new ExecPluginError(
          "unknown_exec_process",
          "The exec process is unknown to this plugin instance and session.",
        );
      }
      const scope = processScope(context);
      const restored = requestResources.terminal(processId, scope, cursor);
      const snapshot = restored
        ? await materializeExecOutput(outputStore, scope, restored)
        : await processManager.wait({
            processId,
            scope,
            cursor,
            waitMs: settings.yieldAfterMs,
          });
      return snapshot.status === "running"
        ? deliverRunning(snapshot, execution, scope, context)
        : finalizeAndRelease({ snapshot, execution, scope, context });
    } catch (error) {
      return execFailureFromError(error, "exec_wait");
    }
  };

  const execCancel: ToolImplementation = async (params, context) => {
    try {
      const processId = readRequiredString(params.process_id, {
        name: "process_id",
        maxLength: 128,
      });
      const execution = pendingExecutions.get(processId);
      if (!execution) {
        throw new ExecPluginError(
          "unknown_exec_process",
          "The exec process is unknown to this plugin instance and session.",
        );
      }
      const scope = processScope(context);
      const restored = requestResources.terminal(processId, scope);
      const snapshot = restored
        ? await materializeExecOutput(outputStore, scope, restored)
        : await processManager.cancel({ processId, scope });
      return finalizeAndRelease({
        snapshot,
        execution,
        scope,
        cancellationIsSuccess: true,
        context,
      });
    } catch (error) {
      return execFailureFromError(error, "exec_cancel");
    }
  };

  return Object.freeze({ exec, exec_wait: execWait, exec_cancel: execCancel });
}
