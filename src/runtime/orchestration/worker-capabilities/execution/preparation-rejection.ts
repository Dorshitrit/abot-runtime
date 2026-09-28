import {
  createTechnicalExecutionFailureResult,
  normalizeCompletedAdapterExecution,
} from "./adapter-result-normalization.js";
import { createWorkerCapabilityExecutionErrorOutcomeFingerprint } from "../outcome-fingerprint.js";
import type {
  WorkerCapabilityPreparedExecution,
  WorkerCapabilityControls,
  WorkerCapabilityAdapterResult,
} from "../contracts.js";

export function preparationRejectionSnapshot(
  actionFingerprint: string | undefined,
  controls: WorkerCapabilityControls,
  error: unknown,
) {
  return {
    kind: "capability_preparation_rejection_v1",
    actionFingerprint,
    acceptedControls: controls,
    result: {
      ...createTechnicalExecutionFailureResult(error),
      failureOutcomeFingerprint:
        createWorkerCapabilityExecutionErrorOutcomeFingerprint(error) ?? null,
    },
  };
}
export function restorePreparationRejection(
  snapshot: unknown,
): WorkerCapabilityPreparedExecution | undefined {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !("kind" in snapshot) ||
    snapshot.kind !== "capability_preparation_rejection_v1"
  )
    return undefined;
  const value = snapshot as ReturnType<typeof preparationRejectionSnapshot>;
  if (
    typeof value.actionFingerprint !== "string" ||
    !value.acceptedControls ||
    typeof value.acceptedControls !== "object"
  )
    throw new Error("capability_preparation_snapshot_invalid");
  const result = structuredClone(value.result) as WorkerCapabilityAdapterResult;
  const checked = normalizeCompletedAdapterExecution(result, "mixed");
  if (
    !checked.ok ||
    checked.execution.result.outcome !== "failed" ||
    checked.execution.result.observedEffect !== "none"
  )
    throw new Error("capability_preparation_snapshot_invalid");
  return {
    actionFingerprint: value.actionFingerprint,
    acceptedControls: value.acceptedControls,
    snapshot: structuredClone(snapshot),
    execute: async () => result,
  };
}
