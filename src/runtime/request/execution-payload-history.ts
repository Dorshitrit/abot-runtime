import { hasExecutionHistoryAuthority } from "../context/execution-history-policy.js";
import type { WorkerCapabilityPayloadModelRequest } from "../orchestration/worker-capabilities/payload-contracts.js";
import type { ExecutionPolicyAuthoritySnapshot } from "../orchestration/role-calls/index.js";
import { createExecutionHistoryReferenceMemory } from "../context/session-memory/execution-reference-memory.js";

/** Authoring receives passive historical tool references, never a conversation replay. */
export function createExecutionPayloadHistoryMemory(
  input: WorkerCapabilityPayloadModelRequest,
  request: Parameters<typeof createExecutionHistoryReferenceMemory>[0],
  authority: ExecutionPolicyAuthoritySnapshot | undefined,
) {
  if (!usesExecutionPayloadHistory(input, authority)) return undefined;
  return createExecutionHistoryReferenceMemory(request, {
    modelStep: input.modelStep,
    callId: "root" in input.context ? input.context.root.callId : input.context.worker.callId,
  });
}

function usesExecutionPayloadHistory(
  input: WorkerCapabilityPayloadModelRequest,
  authority: ExecutionPolicyAuthoritySnapshot | undefined,
): boolean {
  if (!hasExecutionHistoryAuthority(authority)) return false;
  if (input.requestSourceProjection !== "full_request") return false;
  return "root" in input.context;
}

export function usesLegacyPayloadRequestSource(
  input: WorkerCapabilityPayloadModelRequest,
  hasHistoryReference: boolean,
): boolean {
  if (hasHistoryReference) return false;
  return input.requestSourceProjection === "full_request";
}
