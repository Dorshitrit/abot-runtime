import type { SemanticCompactionContinuation } from "./contracts.js";

/** Invocation-local presentation only; never serialized into the checkpoint. */
export type CheckpointContinuationProjector = (
  continuation: SemanticCompactionContinuation,
) => Readonly<Record<string, unknown>>;

export function projectCheckpointContinuation(
  continuation: SemanticCompactionContinuation,
  projector?: CheckpointContinuationProjector,
): Readonly<Record<string, unknown>> {
  if (!projector) return continuation;
  return projector(continuation);
}
