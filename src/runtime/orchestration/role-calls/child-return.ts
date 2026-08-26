import {
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallCommitEffect,
  type RoleCallLedger,
  type RoleCallLedgerCommitResult,
  type RoleCallLedgerHead,
  type RoleCallState,
  type RoleCallWorkerCapabilityScope,
} from "./contracts.js";
import {
  isRuntimeDelegateRoleId,
  type RuntimeDelegateRoleId,
} from "../roles.js";

export type CompletedRoleChildResult = Readonly<{
  callerCallId: string;
  childCallId: string;
  resultRef: string;
  roleId: RuntimeDelegateRoleId;
  objective: string;
  workerCapabilityScope?: RoleCallWorkerCapabilityScope;
  workingDirectory?: string;
  dependencyResultRefs: readonly string[];
  outcome: "completed" | "failed";
  summary: string;
}>;

export type RoleChildReturnContext = Readonly<{
  callerCallId: string;
  invocationAttempt: number;
  returnedChildCallId: string;
  returnedResultRef: string;
  completedChildren: readonly CompletedRoleChildResult[];
}>;

export type RoleCallChildReturnCommit = Readonly<{
  ok: true;
  status: "committed";
  previousHead: RoleCallLedgerHead;
  head: RoleCallLedgerHead;
  effect: Extract<RoleCallCommitEffect, { type: "child_returned" }>;
}>;

export function requireRoleCallChildReturnCommit(
  commit: RoleCallLedgerCommitResult,
): RoleCallChildReturnCommit {
  if (!commit.ok || commit.effect.type !== "child_returned") {
    throw new Error("role_child_return_commit_invalid");
  }
  return commit as RoleCallChildReturnCommit;
}

export function projectRoleChildReturnContext(
  ledger: RoleCallLedger,
  commit: RoleCallLedgerCommitResult,
): RoleChildReturnContext {
  const returned = requireRoleCallChildReturnCommit(commit);
  if (ledger.current() !== returned.head) {
    throw new Error("role_child_return_commit_invalid");
  }

  const { callerCallId, childCallId, resultRef } = returned.effect;
  const previousCaller = returned.previousHead.state.calls.find(
    (call) => call.callId === callerCallId,
  );
  const previousChild = returned.previousHead.state.calls.find(
    (call) => call.callId === childCallId,
  );
  const caller = returned.head.state.calls.find(
    (call) => call.callId === callerCallId,
  );
  if (
    returned.previousHead.state.phase !== "running" ||
    returned.previousHead.state.activeCallId !== childCallId ||
    previousCaller?.status !== "waiting_for_child" ||
    previousChild?.status !== "active" ||
    previousChild.parentCallId !== callerCallId ||
    returned.head.state.phase !== "running" ||
    returned.head.state.activeCallId !== callerCallId ||
    caller?.status !== "active" ||
    caller.activationCount !== previousCaller.activationCount + 1 ||
    !caller.childCallIds.includes(childCallId)
  ) {
    throw new Error("role_child_return_transition_invalid");
  }

  const completedChildren = projectCompletedChildren(
    returned.head.state,
    caller,
  );
  const returnedChild = completedChildren.find(
    (child) =>
      child.childCallId === childCallId && child.resultRef === resultRef,
  );
  if (
    returnedChild?.childCallId !== childCallId ||
    returnedChild.resultRef !== resultRef
  ) {
    throw new Error("role_child_return_result_invalid");
  }

  return Object.freeze({
    callerCallId,
    invocationAttempt: caller.activationCount,
    returnedChildCallId: childCallId,
    returnedResultRef: resultRef,
    completedChildren: Object.freeze(completedChildren),
  });
}

function projectCompletedChildren(
  state: RoleCallState,
  caller: Readonly<{ callId: string; childCallIds: readonly string[] }>,
): readonly CompletedRoleChildResult[] {
  return Object.freeze(
    caller.childCallIds.map((completedChildCallId) =>
      projectCompletedChild(state, {
        callerCallId: caller.callId,
        childCallId: completedChildCallId,
      }),
    ),
  );
}

function projectCompletedChild(
  state: RoleCallState,
  refs: Readonly<{
    callerCallId: string;
    childCallId: string;
  }>,
): CompletedRoleChildResult {
  const child = state.calls.find((call) => call.callId === refs.childCallId);
  const result = state.results.find(
    (candidate) => candidate.resultRef === child?.resultRef,
  );
  if (
    child?.status !== "completed" ||
    child.parentCallId !== refs.callerCallId ||
    !child.resultRef ||
    !isRuntimeDelegateRoleId(child.roleId) ||
    !isBoundedText(child.objective, ROLE_CALL_OBJECTIVE_MAX_LENGTH) ||
    result?.producerCallId !== child.callId ||
    result.roleId !== child.roleId ||
    (result.outcome !== "completed" && result.outcome !== "failed") ||
    !isBoundedText(result.summary, ROLE_CALL_RESULT_MAX_LENGTH)
  ) {
    throw new Error("role_completed_child_projection_invalid");
  }
  return Object.freeze({
    callerCallId: refs.callerCallId,
    childCallId: child.callId,
    resultRef: result.resultRef,
    roleId: result.roleId,
    objective: child.objective,
    ...(child.workerCapabilityScope
      ? { workerCapabilityScope: child.workerCapabilityScope }
      : {}),
    ...(child.workingDirectory !== undefined
      ? { workingDirectory: child.workingDirectory }
      : {}),
    dependencyResultRefs: child.dependencyResultRefs,
    outcome: result.outcome,
    summary: result.summary,
  });
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength
  );
}
