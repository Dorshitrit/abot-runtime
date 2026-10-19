import type { ModelStep } from "../../shared/model-steps.js";
import type { SuperCompactionFailureOwner } from "./super-compaction-failure-owner.js";
import { superPayloadCompactionContractId, type SuperWorkerCompactionSidecar } from "./super-worker-compaction-sidecar.js";
export { withSuperCompactionFailure as withSuperWorkerCompactionFailure } from "./super-compaction-failure-owner.js";

export function superWorkerCompactionFailureOwner(
  sidecar: SuperWorkerCompactionSidecar | undefined,
  modelStep: ModelStep | undefined,
  phase: string,
  scopeId: string,
): SuperCompactionFailureOwner | undefined {
  if (!sidecar || !modelStep) return undefined;
  return Object.freeze({
    head: sidecar.head,
    binding: Object.freeze({
      requestId: sidecar.requestId,
      callId: sidecar.callId,
      parentCallId: sidecar.parentCallId,
      contractId: superPayloadCompactionContractId(sidecar),
      invocationAttempt: sidecar.invocationAttempt,
      sourceRevision: sidecar.sourceRevision,
      modelStep,
      phase,
      scopeId,
    }),
  });
}
