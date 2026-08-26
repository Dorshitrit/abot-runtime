import {
  boundText,
  enforcePluginResultByteBudget,
  failureResult,
  readBoundedInteger,
  readRequiredString,
  type RuntimePluginLoadContext,
  type ToolExecutionContext,
  type ToolImplementation,
  type ToolImplementationOutput,
} from "../../../src/plugin-sdk/index.js";

import { execFailureFromError, ExecPluginError } from "./errors.js";
import {
  captureExecFilesystemSnapshot,
  diffExecFilesystemSnapshots,
} from "./filesystem-observer.js";
import { resolveExecScopedPath, resolveExecWorkingDirectory } from "./paths.js";
import { createExecProcessManager } from "./process-manager.js";
import { EXEC_COMMAND_MAX_CHARS, type ExecSettings } from "./settings.js";
import type {
  ExecFilesystemDelta,
  ExecProcessSnapshot,
  ExecStreamSnapshot,
  PendingExecExecution,
} from "./types.js";
import {
  isInteractiveCommand,
  sanitizeExecCommand,
  scopedPathTokens,
  stripHereDocBodies,
} from "./validation.js";

const COMMAND_PREVIEW_MAX_CHARS = 768;

function processScope(context: ToolExecutionContext | undefined): string {
  const sessionId = context?.sharedState?.currentSessionId?.trim();
  return sessionId || "anonymous";
}

function streamDisplay(snapshot: ExecStreamSnapshot): string {
  if (snapshot.text) return snapshot.text;
  return snapshot.sawOutput
    ? "(no new output; earlier output was already returned)"
    : "(empty)";
}

function renderedOutput(
  lines: readonly string[],
  outputMaxChars: number,
): Readonly<{
  output: string;
  metadata: ReturnType<typeof boundText>["metadata"];
}> {
  const bounded = boundText(lines.join("\n"), {
    maxChars: outputMaxChars,
    marker: "\n[exec output truncated]",
  });
  return Object.freeze({ output: bounded.text, metadata: bounded.metadata });
}

function outputBoundsData(
  snapshot: ExecProcessSnapshot,
  rendered: ReturnType<typeof renderedOutput>["metadata"],
  maxChars: number,
) {
  return Object.freeze({
    maxChars,
    stdout: snapshot.stdout.metadata,
    stderr: snapshot.stderr.metadata,
    rendered,
  });
}

function runningResult(
  snapshot: ExecProcessSnapshot,
  execution: PendingExecExecution,
): ToolImplementationOutput {
  const nextCursor = snapshot.nextCursor ?? 1;
  const rendered = renderedOutput(
    [
      `Command: ${execution.commandPreview}`,
      ...(execution.commandWasNormalized
        ? ["Command normalization: invalid control characters were removed."]
        : []),
      `CWD: ${execution.cwd.logicalPath}`,
      "Process status: running",
      `Process ID: ${snapshot.processId}`,
      `Next cursor: ${nextCursor}`,
      "STDOUT since the previous observation:",
      streamDisplay(snapshot.stdout),
      "STDERR since the previous observation:",
      streamDisplay(snapshot.stderr),
      "Continue this exact process with exec_wait; do not run the command again.",
    ],
    execution.outputMaxChars,
  );
  return failureResult({
    errorCode: "exec_process_running",
    message:
      "The command is still running. Continue it with exec_wait using the returned process ID and cursor.",
    output: rendered.output,
    stdout: snapshot.stdout.text,
    stderr: snapshot.stderr.text,
    data: {
      processId: snapshot.processId,
      processStatus: "running",
      nextCursor,
      outputBounds: outputBoundsData(
        snapshot,
        rendered.metadata,
        execution.outputMaxChars,
      ),
      observationMeta: {
        kind: "volatile_external",
        carryPolicy: "never",
      },
    },
  });
}

async function captureFilesystemDelta(
  execution: PendingExecExecution,
): Promise<ExecFilesystemDelta | null> {
  if (!execution.filesystemStateBefore) return null;
  try {
    const after = await captureExecFilesystemSnapshot(
      execution.cwd.absolutePath,
      execution.cwd.logicalPath,
    );
    return diffExecFilesystemSnapshots(execution.filesystemStateBefore, after);
  } catch {
    return null;
  }
}

async function finalizeExecResult(params: {
  snapshot: ExecProcessSnapshot;
  execution: PendingExecExecution;
  cancellationIsSuccess?: boolean;
}): Promise<ToolImplementationOutput> {
  const { snapshot, execution } = params;
  const exitCode = snapshot.exitCode ?? -1;
  const cancellationIsSuccess =
    params.cancellationIsSuccess === true &&
    snapshot.terminationReason === "cancelled";
  const filesystemDelta = await captureFilesystemDelta(execution);
  const observedStateChange = filesystemDelta?.observedStateChange === true;
  const commandHasData = snapshot.stdout.sawOutput || snapshot.stderr.sawOutput;
  const ok = exitCode === 0 || cancellationIsSuccess;
  const inconclusiveSuccess =
    exitCode === 0 && !commandHasData && !observedStateChange;
  const producedNewInformation =
    observedStateChange || cancellationIsSuccess || (ok && commandHasData);
  const actions = filesystemDelta?.actions ?? [];
  const resultSummary = cancellationIsSuccess
    ? "Result summary: the running command was cancelled."
    : inconclusiveSuccess
      ? "Result summary: the command completed without observable output or filesystem change. Inspect a concrete target or use a dedicated creation capability."
      : "";
  const rendered = renderedOutput(
    [
      `Command: ${execution.commandPreview}`,
      ...(execution.commandWasNormalized
        ? ["Command normalization: invalid control characters were removed."]
        : []),
      `CWD: ${execution.cwd.logicalPath}`,
      `Process ID: ${snapshot.processId}`,
      `Process status: ${snapshot.terminationReason ?? "completed"}`,
      `Exit code: ${exitCode}`,
      ...(filesystemDelta?.observedStateChange
        ? [
            `Filesystem changes observed: ${filesystemDelta.changedEntryCount}${filesystemDelta.observation.complete ? "" : " (bounded observation)"}`,
          ]
        : []),
      "STDOUT:",
      streamDisplay(snapshot.stdout),
      "STDERR:",
      streamDisplay(snapshot.stderr),
      ...(resultSummary ? [resultSummary] : []),
    ],
    execution.outputMaxChars,
  );
  const processStatus = snapshot.terminationReason ?? "completed";
  const data = {
    ...(commandHasData ? { hasData: true } : {}),
    ...(observedStateChange ? { mutationEvidence: true } : {}),
    processId: snapshot.processId,
    processStatus,
    outputBounds: outputBoundsData(
      snapshot,
      rendered.metadata,
      execution.outputMaxChars,
    ),
    ...(filesystemDelta
      ? { filesystemObservation: filesystemDelta.observation }
      : { filesystemObservation: { available: false } }),
    observationMeta: {
      kind: "volatile_external" as const,
      carryPolicy: "never" as const,
    },
  };
  const common = {
    output: rendered.output,
    progress: observedStateChange || cancellationIsSuccess,
    producedNewInformation,
    actions: [...actions],
    exitCode,
    stdout: snapshot.stdout.text,
    stderr: snapshot.stderr.text,
    data,
  };
  if (ok && (!inconclusiveSuccess || cancellationIsSuccess)) {
    return enforcePluginResultByteBudget({ ok: true, ...common });
  }
  const errorCode = inconclusiveSuccess
    ? "no_observable_result"
    : snapshot.terminationReason === "aborted"
      ? "exec_aborted"
      : snapshot.terminationReason === "spawn_failed"
        ? "exec_spawn_failed"
        : snapshot.terminationReason === "idle_timeout"
          ? "exec_idle_timeout"
          : snapshot.terminationReason === "hard_timeout"
            ? "exec_hard_timeout"
            : "non_zero_exit";
  const error = inconclusiveSuccess
    ? resultSummary
    : errorCode === "exec_aborted"
      ? "The exec request was aborted."
      : errorCode === "exec_spawn_failed"
        ? "The runtime could not start the configured non-interactive shell."
        : errorCode === "exec_idle_timeout"
          ? `The command produced no output for ${execution.idleTimeoutMs}ms.`
          : errorCode === "exec_hard_timeout"
            ? `The command exceeded the ${execution.hardTimeoutMs}ms hard timeout.`
            : `The command exited with code ${exitCode}.`;
  return enforcePluginResultByteBudget({
    ok: false,
    ...common,
    error,
    errorCode,
  });
}

type ExecHandlers = Readonly<{
  exec: ToolImplementation;
  exec_wait: ToolImplementation;
  exec_cancel: ToolImplementation;
}>;

export function createExecHandlers(
  pluginContext: RuntimePluginLoadContext,
  settings: ExecSettings,
): ExecHandlers {
  const processManager = createExecProcessManager();
  const pendingExecutions = new Map<string, PendingExecExecution>();

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
      await processManager.release(params.snapshot.processId, params.scope);
    }
  };

  const exec: ToolImplementation = async (params, context) => {
    try {
      const rawCommand = readRequiredString(params.command, {
        name: "command",
        trim: false,
        maxLength: EXEC_COMMAND_MAX_CHARS,
      });
      const { command, normalized } = sanitizeExecCommand(rawCommand);
      if (!command) {
        throw new ExecPluginError(
          "exec_command_invalid",
          "The command is empty after invalid control characters are removed.",
        );
      }
      const interactive = isInteractiveCommand(command);
      if (interactive) {
        throw new ExecPluginError(
          "exec_interactive_command_blocked",
          `Interactive command ${interactive} is not supported by the non-interactive exec plugin.`,
        );
      }
      const cwd = await resolveExecWorkingDirectory(
        pluginContext,
        context,
        params.cwd,
      );
      const staticCommand = stripHereDocBodies(command);
      for (const token of scopedPathTokens(staticCommand)) {
        resolveExecScopedPath(pluginContext, context, token, cwd);
      }
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
        commandWasNormalized: normalized,
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
        onDisposed: (processId) => pendingExecutions.delete(processId),
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
      const snapshot = await processManager.wait({
        processId,
        scope,
        cursor,
        waitMs: settings.yieldAfterMs,
      });
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
      const snapshot = await processManager.cancel({ processId, scope });
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
