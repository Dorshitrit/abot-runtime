import type {
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerHead,
} from "../../role-calls/index.js";
import { traceRoleExecutorStateRejected } from "../diagnostics.js";
import type { RoleExecutorDiagnosticContext } from "./diagnostic-context.js";

export function sameCallFrame(
  left: RoleCallFrame,
  right: RoleCallFrame,
): boolean {
  return (
    sameCallIdentity(left, right) &&
    left.status === right.status &&
    left.activationCount === right.activationCount
  );
}

export function sameCallIdentity(
  left: RoleCallFrame,
  right: RoleCallFrame,
): boolean {
  return (
    left.callId === right.callId &&
    left.parentCallId === right.parentCallId &&
    left.roleId === right.roleId &&
    left.depth === right.depth &&
    left.objective === right.objective &&
    left.workingDirectory === right.workingDirectory &&
    left.resultRef === right.resultRef &&
    sameWorkerCapabilityScope(
      left.workerCapabilityScope,
      right.workerCapabilityScope,
    ) &&
    sameStrings(left.dependencyResultRefs, right.dependencyResultRefs) &&
    sameStrings(left.childCallIds, right.childCallIds)
  );
}

export function sameWorkerCapabilityScope(
  left: RoleCallFrame["workerCapabilityScope"],
  right: RoleCallFrame["workerCapabilityScope"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameStrings(left.catalogGroupIds, right.catalogGroupIds);
}

export function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function readLedgerOrReject(
  params: Readonly<{
    ledger: RoleCallLedger;
    diagnostic: RoleExecutorDiagnosticContext;
    turnCount: number;
  }>,
): RoleCallLedgerHead {
  try {
    return params.ledger.current();
  } catch {
    traceRoleExecutorStateRejected(
      params.diagnostic,
      "ledger_read_failed",
      params.turnCount,
    );
    throw stateError("ledger_read_failed");
  }
}

export function stateError(issueCode: string): Error {
  return new Error(`role_executor_state_invalid:${issueCode}`);
}

export function continuationError(roleId: string, issueCode: string): Error {
  return new Error(`role_executor_continuation_invalid:${roleId}:${issueCode}`);
}

export function childInvocationError(roleId: string, issueCode: string): Error {
  return new Error(
    `role_executor_child_invocation_invalid:${roleId}:${issueCode}`,
  );
}
