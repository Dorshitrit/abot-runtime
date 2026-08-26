import type {
  RoleCallChildReturnCommit,
  RoleCallCommitEffect,
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerCommit,
  RoleCallLedgerHead,
} from "../../role-calls/index.js";
import { normalizeRoleCallWorkingDirectory } from "../../role-calls/index.js";
import type { RuntimeDelegateRoleId } from "../../roles.js";
import type { RoleExecutorRegistry } from "../contracts.js";
import {
  childInvocationError,
  sameCallFrame,
  sameStrings,
  sameWorkerCapabilityScope,
} from "../shared/runtime-invariants.js";

type RoleChildInvocationInput<TContext, TValue> = Parameters<
  RoleExecutorRegistry<TContext, TValue>["invokeChild"]
>[0];

export type ChildOpenedCommit = RoleCallLedgerCommit &
  Readonly<{
    effect: Extract<RoleCallCommitEffect, { type: "child_opened" }>;
  }>;

export type ChildReturnedCommit = RoleCallLedgerCommit &
  Readonly<{
    effect: Extract<RoleCallCommitEffect, { type: "child_returned" }>;
  }>;

export type DelegateRoleCallFrame = RoleCallFrame &
  Readonly<{ roleId: RuntimeDelegateRoleId }>;

export type OpenedChild = Readonly<{
  commit: ChildOpenedCommit;
  call: DelegateRoleCallFrame;
}>;

export function isValidOpenedChildProjection<TContext, TValue>(
  ledger: RoleCallLedger,
  opened: ChildOpenedCommit,
  callerCall: RoleCallFrame,
  input: RoleChildInvocationInput<TContext, TValue>,
  dependencyResultRefs: readonly string[],
  childCall: RoleCallFrame | undefined,
): childCall is DelegateRoleCallFrame {
  return (
    ledger.current() === opened.head &&
    opened.head.state.activeCallId === opened.effect.childCallId &&
    childCall?.parentCallId === callerCall.callId &&
    childCall.roleId === input.roleId &&
    childCall.objective === input.objective &&
    sameWorkerCapabilityScope(
      childCall.workerCapabilityScope,
      input.workerCapabilityScope,
    ) &&
    childCall.workingDirectory ===
      normalizeRoleCallWorkingDirectory(input.workingDirectory) &&
    (input.plannerPlan !== undefined) ===
      (opened.effect.planItemIds !== undefined) &&
    sameStrings(childCall.dependencyResultRefs, dependencyResultRefs) &&
    childCall.status === "active"
  );
}

export function isValidChildReturnTransition(
  commit: ChildReturnedCommit,
  opened: ChildOpenedCommit,
): boolean {
  return (
    (opened.effect.planItemIds === undefined) ===
      (commit.effect.planItemIds === undefined) &&
    sameStrings(
      opened.effect.planItemIds ?? [],
      commit.effect.planItemIds ?? [],
    )
  );
}

export function isValidResumeProjection(
  resume: Readonly<{
    callerCallId: string;
    invocationAttempt: number;
  }>,
  resumedCall: RoleCallFrame,
): boolean {
  return (
    resume.callerCallId === resumedCall.callId &&
    resume.invocationAttempt === resumedCall.activationCount
  );
}

export function projectPriorDirectSiblingResultRefs(
  head: RoleCallLedgerHead,
  callerCall: RoleCallFrame,
): readonly string[] {
  const resultRefs = callerCall.childCallIds.flatMap((childCallId) => {
    const child = head.state.calls.find(
      (candidate) => candidate.callId === childCallId,
    );
    return child?.parentCallId === callerCall.callId &&
      child.status === "completed" &&
      child.resultRef !== null
      ? [child.resultRef]
      : [];
  });
  return Object.freeze(resultRefs);
}

export function resolveActiveCaller(
  params: Readonly<{
    head: RoleCallLedgerHead;
    requestId: string;
    expectedCall: RoleCallFrame;
  }>,
):
  | Readonly<{ ok: true; call: RoleCallFrame }>
  | Readonly<{ ok: false; issueCode: string }> {
  try {
    if (params.head.state.requestId !== params.requestId) {
      return { ok: false, issueCode: "request_id_mismatch" };
    }
    if (
      params.head.state.phase !== "running" ||
      params.head.state.activeCallId !== params.expectedCall.callId
    ) {
      return { ok: false, issueCode: "call_not_current" };
    }
    const call = params.head.state.calls.find(
      (candidate) => candidate.callId === params.expectedCall.callId,
    );
    if (!call) return { ok: false, issueCode: "call_unavailable" };
    if (call.status !== "active") {
      return { ok: false, issueCode: "call_not_active" };
    }
    if (!sameCallFrame(call, params.expectedCall)) {
      return { ok: false, issueCode: "call_identity_mismatch" };
    }
    return { ok: true, call };
  } catch {
    return { ok: false, issueCode: "ledger_head_invalid" };
  }
}

export function requireResumedCallerCall(
  commit: RoleCallChildReturnCommit,
  previousCall: RoleCallFrame,
): RoleCallFrame {
  const resumedCall = commit.head.state.calls.find(
    (candidate) => candidate.callId === previousCall.callId,
  );
  if (
    commit.head.state.phase !== "running" ||
    commit.head.state.activeCallId !== previousCall.callId ||
    resumedCall?.status !== "active" ||
    resumedCall.activationCount !== previousCall.activationCount + 1 ||
    resumedCall.callId !== previousCall.callId ||
    resumedCall.parentCallId !== previousCall.parentCallId ||
    resumedCall.roleId !== previousCall.roleId ||
    resumedCall.depth !== previousCall.depth ||
    resumedCall.objective !== previousCall.objective ||
    resumedCall.workingDirectory !== previousCall.workingDirectory ||
    resumedCall.resultRef !== previousCall.resultRef ||
    resumedCall.childCallIds.length !== previousCall.childCallIds.length + 1 ||
    !previousCall.childCallIds.every(
      (childCallId, index) => resumedCall.childCallIds[index] === childCallId,
    ) ||
    resumedCall.childCallIds.at(-1) !== commit.effect.childCallId
  ) {
    throw childInvocationError(
      previousCall.roleId,
      "caller_resume_projection_invalid",
    );
  }
  return resumedCall;
}
