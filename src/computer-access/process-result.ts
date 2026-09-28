import {
  failureResult,
  successResult,
  type ToolImplementationOutput,
} from "../plugin-sdk/index.js";
import type {
  SystemApplication,
  SystemProcessResult,
  SystemTarget,
} from "./contracts.js";

export type SystemEvidenceScope =
  | "command_process_completion"
  | "launch_request_dispatch";
const STREAM_EXCERPT_CHARS = 2_000;
const IDENTITY_EXCERPT_CHARS = 512;
const LEGACY_EVIDENCE_LABELS: Record<SystemEvidenceScope, string> = {
  command_process_completion: "system command process completion",
  launch_request_dispatch: "application launch request dispatch",
};

export function systemProcessResult(
  target: SystemTarget,
  result: SystemProcessResult,
  evidenceScope: SystemEvidenceScope,
  application?: SystemApplication,
): ToolImplementationOutput {
  const stdoutOmittedChars = Math.max(
    0,
    result.stdout.length - STREAM_EXCERPT_CHARS,
  );
  const stderrOmittedChars = Math.max(
    0,
    result.stderr.length - STREAM_EXCERPT_CHARS,
  );
  const data = {
    evidenceScope,
    evidence: LEGACY_EVIDENCE_LABELS[evidenceScope],
    independentOutcomeCheck: "not_performed" as const,
    target: target.id,
    transport: target.transport,
    processStatus: result.status,
    spawnedProcess: result.spawnedProcess ?? null,
    ...(application ? { catalogApplication: application } : {}),
    outputTruncated: result.outputTruncated,
    summaryOmittedChars: {
      stdout: stdoutOmittedChars,
      stderr: stderrOmittedChars,
    },
    observationMeta: {
      kind: "volatile_external" as const,
      carryPolicy: "never" as const,
    },
  };
  const output = [
    `Adapter evidence: ${evidenceScope}. Independent outcome check: not performed. Completion/dispatch alone does not verify the requested application, window or system effect; evaluate command evidence separately.`,
    `Target: ${target.id} (${target.transport})`,
    `Process status: ${result.status}; exit code: ${result.exitCode ?? "unavailable"}`,
    result.spawnedProcess
      ? `Spawned helper: ${identityExcerpt(result.spawnedProcess.executable)}; PID ${result.spawnedProcess.pid} in runtime OS namespace. Identity comes from spawn arguments, not application image inspection.`
      : "Spawned helper identity: not recorded.",
    ...(application
      ? [
          `Revalidated catalog identity: ${identityExcerpt(application.id)} (identity only; no application process/window check).`,
        ]
      : []),
    "STDOUT excerpt:",
    result.stdout.slice(0, STREAM_EXCERPT_CHARS) || "(empty)",
    "STDERR excerpt:",
    result.stderr.slice(0, STREAM_EXCERPT_CHARS) || "(empty)",
    `Summary omitted characters: stdout=${stdoutOmittedChars}, stderr=${stderrOmittedChars}. Raw stream capture truncated: ${result.outputTruncated}.`,
  ].join("\n");
  if (hasSuccessfulSystemObservation(result)) {
    return successResult({
      output,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
      data,
    });
  }
  const errorCode =
    result.status === "completed"
      ? "system_command_failed"
      : `system_${result.status}`;
  return failureResult({
    errorCode,
    message: hasUncertainDescendantState(result)
      ? "System command observation stopped. External or detached descendants may remain; inspect the target before retrying."
      : "The target did not report successful command completion.",
    output,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    data,
  });
}

function hasSuccessfulSystemObservation(result: SystemProcessResult): boolean {
  if (result.status !== "completed") return false;
  return result.exitCode === 0;
}
function hasUncertainDescendantState(result: SystemProcessResult): boolean {
  if (result.status === "timeout") return true;
  return result.status === "aborted";
}

function identityExcerpt(identity: string): string {
  if (identity.length <= IDENTITY_EXCERPT_CHARS) return identity;
  return `${identity.slice(0, IDENTITY_EXCERPT_CHARS)} [${identity.length - IDENTITY_EXCERPT_CHARS} characters omitted; full identity in result data]`;
}
