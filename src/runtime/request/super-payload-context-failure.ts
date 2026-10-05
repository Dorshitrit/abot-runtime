import type { WorkerCapabilityPayloadModelRequest } from "../orchestration/worker-capabilities/payload-contracts.js";
import type { RequestContextCompactionStore } from "../context/semantic-compaction/store.js";
import { SuperContextFailure } from "../context/super-context-failure.js";
import { hasSuperContextContract } from "../context/super-context-policy.js";
import { validateRoleCallCandidate } from "../orchestration/role-calls/reducer.js";
import { quarantineProvenOwnedSuperCheckpoint } from "./super-checkpoint-quarantine.js";
import { traceDebug } from "../observability/debug-logger.js";

type PayloadRequest = Readonly<{
  requestId: string;
  prompt: string;
  abortSignal: AbortSignal;
  contextCompactionStore?: RequestContextCompactionStore;
}>;

/** Preserve normal failed-capability settlement; never create a role commit here. */
export function quarantineOwnedSuperPayloadCheckpoint(
  request: PayloadRequest,
  input: WorkerCapabilityPayloadModelRequest,
  error: unknown,
): void {
  if (request.abortSignal.aborted || !(error instanceof SuperContextFailure))
    return;
  const sidecar = input.superWorkerCompaction;
  if (!sidecar || !request.contextCompactionStore) return;
  const head = sidecar.head;
  if (!hasSuperContextContract(head.policy.authority, "delegated.worker"))
    return;
  const call = head.state.calls.find(
    (candidate) => candidate.callId === sidecar.callId,
  );
  if (!call || call.roleId !== "worker" || call.status !== "active") return;
  if (head.state.phase !== "running" || head.state.activeCallId !== call.callId)
    return;
  if (
    head.state.requestId !== request.requestId ||
    sidecar.requestId !== request.requestId
  )
    return;
  if (
    sidecar.sourceRevision !== head.revision ||
    sidecar.invocationAttempt !== call.activationCount
  )
    return;
  const binding = error.binding;
  if (binding.requestId !== request.requestId || binding.callId !== call.callId)
    return;
  if (
    binding.parentCallId !== call.parentCallId ||
    binding.contractId !== "delegated.worker"
  )
    return;
  if (
    binding.sourceRevision !== head.revision ||
    binding.invocationAttempt !== call.activationCount
  )
    return;
  if (
    binding.scopeId !== `worker:${call.callId}:request-tool-results` ||
    binding.modelStep !== input.modelStep
  )
    return;
  if (
    validateRoleCallCandidate({ state: head.state, policy: head.policy }).length
  )
    return;
  const validation = quarantineProvenOwnedSuperCheckpoint({
    requestId: request.requestId,
    prompt: request.prompt,
    head,
    store: request.contextCompactionStore,
    scopeId: binding.scopeId,
  });
  if (validation)
    traceDebug("runtime.context.compaction", "payload_checkpoint.quarantined", {
      ...binding,
      code: error.code,
      validationCode: validation,
      route: "settle_then_fresh_activation",
    });
}
