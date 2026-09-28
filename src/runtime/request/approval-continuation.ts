import type { RoleCallLedger } from "../orchestration/role-calls/index.js";
import type { RoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import type {
  EnteredChildCursor,
  RoleApprovalContinuation,
} from "../orchestration/role-executors/approval-continuation.js";
import { validateRoleApprovalWait } from "../orchestration/role-executors/approval-continuation.js";
import { restoreEnteredChild } from "../orchestration/role-executors/child-invocation/entered-child.js";
import type { PreparedApprovalGroup } from "../orchestration/worker-capabilities/approval-contracts.js";
import type { WorkerCapabilityDescriptor } from "../orchestration/worker-capabilities/contracts.js";
import { projectWorkerCapabilityScope } from "../orchestration/worker-capabilities/scope.js";
import type { RootContinuationPresentation } from "./root-execution-contracts.js";
import type { RequestRunnerResult } from "./result.js";

/** Logical continuation only, captured at an admitted, undispatched approval boundary. */
export type RequestApprovalContinuation = Readonly<{
  kind: "request_approval_continuation_v1";
  ledger: RoleCallLedgerCheckpoint;
  root: RootContinuationPresentation;
  callers: readonly EnteredChildCursor[];
  preparedGroup: PreparedApprovalGroup;
}>;

export type RequestRunnerOutcome =
  | Readonly<{ kind: "completed"; result: RequestRunnerResult }>
  | Readonly<{
      kind: "awaiting_approval";
      continuation: RequestApprovalContinuation;
    }>;

export function validateRequestApprovalContinuation(
  continuation: RequestApprovalContinuation,
  ledger: RoleCallLedger,
  capabilities?: readonly WorkerCapabilityDescriptor[],
): void {
  if (continuation?.kind !== "request_approval_continuation_v1")
    throw new Error("request_approval_continuation_invalid");
  if (typeof continuation.root?.acknowledgementPublished !== "boolean")
    throw new Error("request_approval_presentation_invalid");
  if (typeof continuation.root.titlePublished !== "boolean")
    throw new Error("request_approval_presentation_invalid");
  const state = ledger.current().state;
  let callerId = state.rootCallId;
  if (!Array.isArray(continuation.callers))
    throw new Error("request_approval_callers_invalid");
  if (continuation.callers.length > ledger.current().policy.limits.maxDepth)
    throw new Error("request_approval_callers_too_deep");
  for (const cursor of continuation.callers) {
    if (cursor.callerCall.callId !== callerId)
      throw new Error("request_approval_caller_chain_invalid");
    const entered = restoreEnteredChild(ledger, cursor);
    callerId = entered.call.callId;
  }
  if (callerId !== continuation.preparedGroup.callId)
    throw new Error("request_approval_leaf_mismatch");
  const call = state.calls.find((candidate) => candidate.callId === callerId);
  if (!call) throw new Error("request_approval_leaf_missing");
  validateRoleApprovalWait(ledger, call, {
    kind: "awaiting_approval",
    group: continuation.preparedGroup,
    callers: continuation.callers,
  });
  // Validate every returning caller as well as the leaf before an approved
  // effect can run. Unrelated, already settled calls are not resumed.
  const hasCurrentCapabilityCatalog = capabilities !== undefined;
  if (!hasCurrentCapabilityCatalog) return;
  const resumedCalls = [
    ...continuation.callers.map((cursor) => cursor.callerCall),
    call,
  ];
  for (const resumed of resumedCalls) {
    projectWorkerCapabilityScope({
      entries: capabilities,
      scope: resumed.workerCapabilityScope,
      descriptorOf: (entry) => entry,
    });
  }
}

export function createRoleApprovalContinuation(
  continuation: RequestApprovalContinuation,
  executionIds: readonly string[],
): RoleApprovalContinuation {
  if (executionIds.length === 0)
    throw new Error("request_approval_execution_empty");
  return Object.freeze({
    callers: continuation.callers,
    capability:
      executionIds.length === 1
        ? Object.freeze({
            kind: "capability_execution",
            executionId: executionIds[0]!,
          })
        : Object.freeze({ kind: "capability_batch_execution", executionIds }),
  });
}
