import type { RoleCallFrame, RoleCallLedger } from "../role-calls/index.js";
import type { WorkerCapabilityApprovalWait } from "../worker-capabilities/approval-contracts.js";
import type {
  RoleCapabilityBatchExecutionContinuationReference,
  RoleCapabilityExecutionContinuationReference,
} from "./contracts.js";

/** The already-open child boundary. It carries no commit or writer authority. */
export type EnteredChildCursor = Readonly<{
  callerCall: RoleCallFrame;
  childCallId: string;
  planItemIds?: readonly string[];
  turnCount: number;
}>;

export type RoleApprovalWait = WorkerCapabilityApprovalWait &
  Readonly<{
    callers: readonly EnteredChildCursor[];
  }>;

export type RoleApprovalContinuation = Readonly<{
  callers: readonly EnteredChildCursor[];
  capability:
    | RoleCapabilityExecutionContinuationReference
    | RoleCapabilityBatchExecutionContinuationReference;
}>;

export function isRoleApprovalWait(value: unknown): value is RoleApprovalWait {
  if (typeof value !== "object" || value === null) return false;
  if (!("kind" in value) || value.kind !== "awaiting_approval") return false;
  return "callers" in value && Array.isArray(value.callers);
}

export function bindRoleApprovalWait(
  wait: WorkerCapabilityApprovalWait,
): RoleApprovalWait {
  return Object.freeze({ ...wait, callers: Object.freeze([]) });
}

export function validateRoleApprovalWait(
  ledger: RoleCallLedger,
  call: RoleCallFrame,
  wait: RoleApprovalWait,
): void {
  const head = ledger.current();
  if (wait.group.requestId !== head.state.requestId)
    throw new Error("role_approval_request_mismatch");
  if (wait.group.callId !== call.callId)
    throw new Error("role_approval_call_mismatch");
  if (wait.group.invocationAttempt !== call.activationCount)
    throw new Error("role_approval_activation_mismatch");
  if (head.state.activeCallId !== call.callId)
    throw new Error("role_approval_active_call_mismatch");
  const current = head.state.calls.find(
    (entry) => entry.callId === call.callId,
  );
  if (current?.status !== "waiting_for_capability")
    throw new Error("role_approval_call_not_waiting");
  const running = head.state.capabilityExecutions.filter(
    (entry) => entry.status === "running",
  );
  if (running.length !== wait.group.entries.length)
    throw new Error("role_approval_group_incomplete");
  for (const entry of wait.group.entries) {
    const execution = running.find(
      (candidate) => candidate.executionId === entry.executionId,
    );
    if (execution?.callId !== call.callId)
      throw new Error("role_approval_execution_mismatch");
    if (execution.actionFingerprint !== entry.actionFingerprint)
      throw new Error("role_approval_action_mismatch");
  }
}
