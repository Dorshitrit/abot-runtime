import type { ExecFilesystemDelta } from "./types.js";

/** Describe the existing observation, never infer effects from command text. */
export function summarizeExecFilesystemObservation(
  delta: ExecFilesystemDelta | null,
  logicalRoot: string,
): string {
  const scope = `under CWD (${logicalRoot})`;
  if (!delta) {
    return `Filesystem observation unavailable ${scope}; changes are unknown.`;
  }
  const coverage = delta.observation.complete
    ? "complete"
    : "incomplete; changes may be unobserved";
  if (delta.observedStateChange) {
    return `Filesystem changes observed: ${delta.changedEntryCount} ${scope}; observation ${coverage}.`;
  }
  return `No filesystem changes observed ${scope}; observation ${coverage}.`;
}
