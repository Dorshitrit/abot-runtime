import {
  deliverPluginTextResult,
  type ToolImplementationOutput,
  type ToolResultBudget,
} from "../../../src/plugin-sdk/index.js";
import {
  captureExecFilesystemSnapshot,
  diffExecFilesystemSnapshots,
} from "./filesystem-observer.js";
import type {
  ExecActionSummary,
  ExecFilesystemDelta,
  ExecProcessSnapshot,
  ExecStreamSnapshot,
  ExecStreamMetadata,
  PendingExecExecution,
} from "./types.js";

const EXEC_CONTEXT_TEXT_FIELDS = Object.freeze(["stdout", "stderr"] as const);

function streamReceipt(
  snapshot: ExecStreamSnapshot,
  field: "stdout" | "stderr",
): string {
  if (snapshot.text) return `See the ${field} field (${snapshot.text.length} characters).`;
  return snapshot.sawOutput
    ? "(no new output; earlier output was already returned)"
    : "(empty)";
}

function renderedOutput(lines: readonly string[]): Readonly<{
  output: string;
  metadata: ExecStreamMetadata;
}> {
  const output = lines.join("\n");
  return Object.freeze({
    output,
    metadata: Object.freeze({
      truncated: false,
      originalChars: output.length,
      returnedChars: output.length,
      omittedChars: 0,
    }),
  });
}

function outputBoundsData(
  snapshot: ExecProcessSnapshot,
  rendered: ExecStreamMetadata,
) {
  return Object.freeze({
    maxChars: null,
    stdout: snapshot.stdout.metadata,
    stderr: snapshot.stderr.metadata,
    rendered,
  });
}

export function runningResult(
  snapshot: ExecProcessSnapshot,
  execution: PendingExecExecution,
  resultBudget?: ToolResultBudget,
): ToolImplementationOutput {
  const nextCursor = snapshot.nextCursor ?? 1;
  const rendered = renderedOutput(
    [
      `Command: ${execution.commandPreview}`,
      `CWD: ${execution.cwd.logicalPath}`,
      "Process status: running",
      `Process ID: ${snapshot.processId}`,
      `Next cursor: ${nextCursor}`,
      "STDOUT since the previous observation:",
      streamReceipt(snapshot.stdout, "stdout"),
      "STDERR since the previous observation:",
      streamReceipt(snapshot.stderr, "stderr"),
      "Continue this exact process with exec_wait; do not run the command again.",
    ],
  );
  return deliverPluginTextResult({
    ok: false,
    producedNewInformation: false,
    errorCode: "exec_process_running",
    error:
      "The command is still running. Continue it with exec_wait using the returned process ID and cursor.",
    output: rendered.output,
    stdout: snapshot.stdout.text,
    stderr: snapshot.stderr.text,
    data: {
      processId: snapshot.processId,
      processStatus: "running",
      nextCursor,
      outputBounds: outputBoundsData(snapshot, rendered.metadata),
      observationMeta: {
        kind: "volatile_external",
        carryPolicy: "never",
      },
    },
  }, EXEC_CONTEXT_TEXT_FIELDS, resultBudget);
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

type ExecFilesystemEvidenceProjection = Readonly<{
  outputLines: readonly string[];
  mutationGrounding: string;
}>;

function projectExecFilesystemEvidence(
  delta: ExecFilesystemDelta,
  logicalRoot: string,
): ExecFilesystemEvidenceProjection {
  const effects = delta.actions.map(renderExecFilesystemEffect);
  const omittedEffectCount = Math.max(
    0,
    delta.changedEntryCount - effects.length,
  );
  const omittedEffectLine =
    omittedEffectCount > 0
      ? `- ${omittedEffectCount} additional changed ${omittedEffectCount === 1 ? "entry" : "entries"} omitted by the ${delta.observation.actionLimit}-effect projection limit.`
      : undefined;
  const outputLines = Object.freeze([
    `Filesystem changes observed: ${delta.changedEntryCount}${delta.observation.complete ? "" : " (bounded observation)"}`,
    "Filesystem effects observed:",
    ...effects,
    ...(omittedEffectLine ? [omittedEffectLine] : []),
  ]);
  return Object.freeze({
    outputLines,
    mutationGrounding: [
      "Observed post-command filesystem effects (settled tool evidence; not command intent, semantic verification, or complete artifact content):",
      `- observation root: ${logicalRoot}`,
      `- observation complete: ${delta.observation.complete}`,
      `- changed entries: ${delta.changedEntryCount}`,
      `- listed effects: ${effects.length}`,
      `- effects truncated: ${delta.observation.actionsTruncated}`,
      "Effects:",
      ...effects,
      ...(omittedEffectLine ? [omittedEffectLine] : []),
    ].join("\n"),
  });
}

function renderExecFilesystemEffect(action: ExecActionSummary): string {
  const target = action.target ? `: ${action.target}` : "";
  const state =
    action.details === "exec_filesystem_created"
      ? "created"
      : action.details === "exec_filesystem_modified"
        ? "modified"
        : action.details === "exec_filesystem_removed"
          ? "removed"
          : undefined;
  return `- ${action.type}${target}${state ? ` (${state})` : ""}`;
}

export async function finalizeExecResult(params: {
  snapshot: ExecProcessSnapshot;
  execution: PendingExecExecution;
  cancellationIsSuccess?: boolean;
  resultBudget?: ToolResultBudget;
}): Promise<ToolImplementationOutput> {
  const { snapshot, execution } = params;
  const exitCode = snapshot.exitCode ?? -1;
  const cancellationIsSuccess =
    params.cancellationIsSuccess === true &&
    snapshot.terminationReason === "cancelled";
  const filesystemDelta = await captureFilesystemDelta(execution);
  const observedStateChange = filesystemDelta?.observedStateChange === true;
  const filesystemEvidence =
    observedStateChange && filesystemDelta
      ? projectExecFilesystemEvidence(
          filesystemDelta,
          execution.cwd.logicalPath,
        )
      : null;
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
      `CWD: ${execution.cwd.logicalPath}`,
      `Process ID: ${snapshot.processId}`,
      `Process status: ${snapshot.terminationReason ?? "completed"}`,
      `Exit code: ${exitCode}`,
      ...(filesystemEvidence ? filesystemEvidence.outputLines : []),
      "STDOUT:",
      streamReceipt(snapshot.stdout, "stdout"),
      "STDERR:",
      streamReceipt(snapshot.stderr, "stderr"),
      ...(resultSummary ? [resultSummary] : []),
    ],
  );
  const processStatus = snapshot.terminationReason ?? "completed";
  const data = {
    ...(commandHasData ? { hasData: true } : {}),
    ...(observedStateChange ? { mutationEvidence: true } : {}),
    ...(filesystemEvidence
      ? { mutationGrounding: filesystemEvidence.mutationGrounding }
      : {}),
    processId: snapshot.processId,
    processStatus,
    outputBounds: outputBoundsData(snapshot, rendered.metadata),
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
    return deliverPluginTextResult({ ok: true, ...common }, EXEC_CONTEXT_TEXT_FIELDS, params.resultBudget);
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
  return deliverPluginTextResult({
    ok: false,
    ...common,
    error,
    errorCode,
  }, EXEC_CONTEXT_TEXT_FIELDS, params.resultBudget);
}
