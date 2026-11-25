import type { CapabilityDescriptor } from "../../orchestration/capability-adapters/index.js";
import type { RoleCallFrame, RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
import type { PreparedApprovalGroup } from "../../orchestration/worker-capabilities/approval-contracts.js";
import { matchesFilePayloadContinuationExecution, projectFilePayloadContinuation } from "./continuation.js";
import { isFilePayloadObservationCapability } from "./tool-scope.js";

/** Saved preparations bypass RAW parsing. Inspect only their active canonical handoff lineage
 * before restoring an adapter or executing a previously approved operation.
 */
export function assertFilePayloadApprovalCompatible(params: Readonly<{
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  group: PreparedApprovalGroup;
  capabilities: readonly CapabilityDescriptor[];
}>): void {
  if (params.head.policy.authority.rootContractId !== "execution_agent") return;
  if (params.call.callId !== params.head.state.rootCallId) return;
  const { group } = params;
  const token = group.executionFreshnessToken;
  const pending = projectFilePayloadContinuation({
    // The parked operation is admitted but not settled. Replay the preceding receipts only.
    executions: params.head.state.capabilityExecutions.filter((execution) =>
      execution.invocationAttempt < group.invocationAttempt),
    call: params.call,
    ...(token?.kind === "request_steering_v1" ? { steeringVersion: token.version } : {}),
    capabilities: params.capabilities,
  });
  if (!pending) return;
  const admitted = params.head.state.capabilityExecutions.filter((execution) =>
    execution.callId === group.callId && execution.invocationAttempt === group.invocationAttempt);
  if (!matchesFilePayloadContinuationExecution(pending, group.invocationAttempt, admitted)) return;
  if (!pending.observationToolsOnly) throw new Error("execution_file_handoff_approval_incompatible");
  if (pending.phase === "write") return;
  if (admitted.every((execution) => isFilePayloadObservationCapability({ effect: execution.declaredEffect }))) return;
  throw new Error("execution_file_handoff_approval_incompatible");
}
