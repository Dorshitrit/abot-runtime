import { isDeepStrictEqual } from "node:util";
import type {
  WorkerCapabilityAdapterRestoreInput,
  WorkerCapabilityAdapterResult,
  WorkerCapabilityPreparedExecution,
} from "../../orchestration/worker-capabilities/index.js";
import { normalizeCompletedAdapterExecution } from "../../orchestration/worker-capabilities/execution/adapter-result-normalization.js";
import { createPreparedWorkerInvocation } from "./prepared-execution.js";

type Params = Parameters<typeof createPreparedWorkerInvocation>[0] & {
  executor: import("../registered-tool-normal-invocations.js").RegisteredToolNormalInvocationExecutor;
};
export function createPreparedRejectionSnapshot(
  capabilityId: string,
  actionFingerprint: string,
  acceptedControls: Readonly<Record<string, unknown>>,
  result: WorkerCapabilityAdapterResult,
) {
  return Object.freeze(
    structuredClone({
      kind: "registered_worker_rejection_v1",
      capabilityId,
      actionFingerprint,
      acceptedControls,
      result,
    }),
  );
}

/** Owning adapter hydration: no normalization, payload author, or external call. */
export async function restorePreparedWorkerInvocation<TContext>(
  params: Params,
  input: WorkerCapabilityAdapterRestoreInput<TContext>,
  snapshot: unknown,
): Promise<WorkerCapabilityPreparedExecution> {
  if (
    !isRecord(snapshot) ||
    snapshot.capabilityId !== params.descriptor.capabilityId
  )
    throw invalid();
  if (snapshot.kind === "registered_worker_rejection_v1") {
    if (
      typeof snapshot.actionFingerprint !== "string" ||
      !isRecord(snapshot.acceptedControls) ||
      !isDeepStrictEqual(snapshot.acceptedControls, input.controls) ||
      !isRecord(snapshot.result)
    )
      throw invalid();
    const raw = snapshot.result as WorkerCapabilityAdapterResult;
    const normalized = normalizeCompletedAdapterExecution(
      raw,
      params.descriptor.effect,
    );
    if (!normalized.ok || normalized.execution.result.outcome !== "failed")
      throw invalid();
    const result = structuredClone(raw);
    return Object.freeze({
      actionFingerprint: snapshot.actionFingerprint,
      acceptedControls: snapshot.acceptedControls,
      snapshot: structuredClone(snapshot),
      execute: async () => result,
    });
  }
  if (
    snapshot.kind !== "registered_worker_invocation_v1" ||
    !Array.isArray(snapshot.selectedTargetReferences) ||
    !snapshot.selectedTargetReferences.every(
      (ref) =>
        isRecord(ref) &&
        ref.kind === "tool_target" &&
        typeof ref.target === "string",
    )
  )
    throw invalid();
  const normal = params.executor.restore(snapshot.normal);
  if (
    normal.status !== "prepared" ||
    !isDeepStrictEqual(normal.acceptedControls, input.controls)
  )
    throw invalid();
  return createPreparedWorkerInvocation(
    params,
    input,
    normal,
    snapshot.selectedTargetReferences,
    { release() {} },
  );
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid() {
  return new Error("registered_worker_snapshot_incompatible");
}
