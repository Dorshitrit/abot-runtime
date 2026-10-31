import type { RoleCallLedger } from "../orchestration/role-calls/index.js";
import type { RequestExecutionScope } from "./execution-scope.js";
import {
  createRoleApprovalContinuation,
  type RequestApprovalContinuation,
} from "./approval-continuation.js";
import { restoreCapabilityApprovalGroup } from "../orchestration/worker-capabilities/execution/approval-group.js";
import { hasSuperContextContract } from "../context/super-context-policy.js";
import type { RoleCallLedgerHead } from "../orchestration/role-calls/index.js";
import type { PreparedApprovalGroup } from "../orchestration/worker-capabilities/approval-contracts.js";
import {
  createWorkerExecutionFreshness,
  restoreApprovalExecutionFreshness,
} from "./capability-execution-freshness.js";
import {
  resolveRequestSteeringInbox,
  type RequestSteeringInbox,
} from "./request-steering.js";

export function restoreBoundApprovalFreshness(
  group: PreparedApprovalGroup,
  inbox: RequestSteeringInbox | undefined,
  head: RoleCallLedgerHead,
) {
  const restored = restoreApprovalExecutionFreshness(
    group.executionFreshnessToken,
    inbox,
  );
  if (restored) return restored;
  if (!hasSuperContextContract(head.policy.authority, "delegated.worker"))
    return undefined;
  const call = head.state.calls.find(
    (candidate) => candidate.callId === group.callId,
  );
  if (!call || call.roleId !== "worker" || call.parentCallId === null)
    return undefined;
  return createWorkerExecutionFreshness({
    requestSteering: resolveRequestSteeringInbox(inbox),
    call,
  });
}

/** Final admission after all awaited persistence, before the live request parks. */
export async function settleSupersededWorkerApprovalBeforePark(
  request: RequestExecutionScope,
  ledger: RoleCallLedger,
  continuation: RequestApprovalContinuation,
) {
  const head = ledger.current();
  if (!hasSuperContextContract(head.policy.authority, "delegated.worker"))
    return undefined;
  const call = head.state.calls.find(
    (candidate) => candidate.callId === continuation.preparedGroup.callId,
  );
  if (!call || call.roleId !== "worker" || call.parentCallId === null)
    return undefined;
  request.abortSignal.throwIfAborted();
  const freshness = restoreBoundApprovalFreshness(
    continuation.preparedGroup,
    request.requestSteering,
    head,
  );
  if (freshness?.token.kind !== "worker_steering_v1") return undefined;
  const inbox = resolveRequestSteeringInbox(request.requestSteering);
  if (freshness.isCurrent()) {
    if (!inbox.seal(freshness.token.version))
      throw new Error("request_approval_steering_seal_rejected");
    return undefined;
  }
  const prepared = await restoreCapabilityApprovalGroup({
    executionFreshness: freshness,
    ledger,
    context: request.workerCapabilities.executionContext,
    adapters: request.workerCapabilities.provider.getAdapters(),
    group: continuation.preparedGroup,
  });
  request.abortSignal.throwIfAborted();
  const settled = await prepared.execute([]);
  return createRoleApprovalContinuation(continuation, settled.executionIds);
}
