import type { SessionArtifactPath, SessionArtifactPathInput } from "./types.js";

export const MAX_SESSION_ARTIFACT_PATHS = 64;
export const MAX_SESSION_ARTIFACT_PATH_TARGET_LENGTH = 4096;

export function assertValidSessionArtifactPathInputs(
  inputs: readonly SessionArtifactPathInput[],
): void {
  if (!Array.isArray(inputs)) {
    throw new Error("session_artifact_path_inputs_invalid");
  }
  for (const input of inputs) {
    if (
      !input ||
      typeof input.target !== "string" ||
      input.target.trim().length === 0
    ) {
      throw new Error("session_artifact_path_target_required");
    }
    if (input.target.length > MAX_SESSION_ARTIFACT_PATH_TARGET_LENGTH) {
      throw new Error("session_artifact_path_target_too_long");
    }
    if (
      typeof input.sourceRequestId !== "string" ||
      input.sourceRequestId.trim().length === 0
    ) {
      throw new Error("session_artifact_path_source_request_id_required");
    }
    if (
      typeof input.sourceExecutionId !== "string" ||
      input.sourceExecutionId.trim().length === 0
    ) {
      throw new Error("session_artifact_path_source_execution_id_required");
    }
  }
}

/**
 * Keeps session artifact paths in oldest-to-newest recency order. Reusing an
 * exact target refreshes its provenance and moves it to the newest position.
 */
export function upsertSessionArtifactPaths(
  existing: readonly SessionArtifactPath[],
  inputs: readonly SessionArtifactPathInput[],
  timestamp: string,
): SessionArtifactPath[] {
  assertValidSessionArtifactPathInputs(inputs);
  let next = existing.map((entry) => ({ ...entry }));

  for (const input of inputs) {
    const previous = findNewestExactTarget(next, input.target);
    next = next.filter((entry) => entry.target !== input.target);
    next.push({
      ...input,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }

  return next.slice(-MAX_SESSION_ARTIFACT_PATHS);
}

function findNewestExactTarget(
  entries: readonly SessionArtifactPath[],
  target: string,
): SessionArtifactPath | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.target === target) {
      return entries[index];
    }
  }
  return undefined;
}
