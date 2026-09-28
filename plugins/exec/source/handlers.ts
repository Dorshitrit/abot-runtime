import { runningResult, finalizeExecResult } from "./result-presentation.js";
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
  const processManager = createExecProcessManager();
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
  }): Promise<ToolImplementationOutput> => {
    try {
      return await finalizeExecResult(params);
    } finally {
      pendingExecutions.delete(params.snapshot.processId);
      requestResources.forget(params.snapshot.processId);
      await processManager.release(params.snapshot.processId, params.scope);
    }
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
        outputMaxChars: settings.outputMaxChars,
      });
      const scope = processScope(context);
      const snapshot = await processManager.start({
        scope,
        shellCommand: command,
        cwd: cwd.absolutePath,
        outputMaxChars: settings.outputMaxChars,
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
        return runningResult(snapshot, execution);
      }
      return finalizeAndRelease({ snapshot, execution, scope });
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
      const snapshot =
        requestResources.terminal(processId, scope, cursor) ??
        (await processManager.wait({
          processId,
          scope,
          cursor,
          waitMs: settings.yieldAfterMs,
        }));
      return snapshot.status === "running"
        ? runningResult(snapshot, execution)
        : finalizeAndRelease({ snapshot, execution, scope });
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
      const snapshot =
        requestResources.terminal(processId, scope) ??
        (await processManager.cancel({ processId, scope }));
      return finalizeAndRelease({
        snapshot,
        execution,
        scope,
        cancellationIsSuccess: true,
      });
    } catch (error) {
      return execFailureFromError(error, "exec_cancel");
    }
  };

  return Object.freeze({ exec, exec_wait: execWait, exec_cancel: execCancel });
}
