import type { ChatMessage } from "../../../model-gateway/types.js";
import {
  projectStoredCompletedRoleChild,
  type CompletedRoleChildResult,
} from "../../orchestration/role-calls/child-return.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";

export const EXECUTION_ROLE_TOOL_NAME = "runtime_role" as const;
export const EXECUTION_ROLE_ACTION_MESSAGE_KIND = "runtime_execution_role_action_v1" as const;
export const EXECUTION_ROLE_RESULT_MESSAGE_KIND = "runtime_execution_role_result_v1" as const;

export type ExecutionChildContinuation = Readonly<{
  invocationAttempt: number;
  messages: readonly ChatMessage[];
  resultRef: string;
}>;

/** Reconstruct settled direct-child interactions from accepted ledger state only. */
export function projectExecutionChildContinuations(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): readonly ExecutionChildContinuation[] {
  const caller = head.state.calls.find(({ callId }) => callId === call.callId);
  if (!isCurrentExecutionCaller(head, call, caller))
    throw new Error("execution_agent_child_continuation_caller_invalid");
  return Object.freeze(caller.childCallIds.flatMap((childCallId) => {
    const child = head.state.calls.find(({ callId }) => callId === childCallId);
    if (!child) throw new Error("role_completed_child_projection_invalid");
    if (child.status !== "completed") return [];
    // Legacy snapshots have no trustworthy ordering position. Keep their old lane.
    if (child.parentInvocationAttempt === undefined) return [];
    if (!hasBoundParentInvocationAttempt(child.parentInvocationAttempt, caller.activationCount))
      throw new Error("execution_agent_child_continuation_attempt_invalid");
    const result = projectStoredCompletedRoleChild(
      head.state,
      { callerCallId: caller.callId, childCallId },
      head.policy,
    );
    return [buildChildContinuation(result, child.parentInvocationAttempt)];
  }));
}

function isCurrentExecutionCaller(
  head: RoleCallLedgerHead,
  supplied: RoleCallFrame,
  caller: RoleCallFrame | undefined,
): caller is RoleCallFrame {
  if (!caller) return false;
  if (head.state.phase !== "running") return false;
  if (caller.callId !== head.state.rootCallId) return false;
  if (caller.callId !== head.state.activeCallId) return false;
  if (caller.parentCallId !== null) return false;
  if (caller.status !== "active") return false;
  return caller.activationCount === supplied.activationCount;
}

function hasBoundParentInvocationAttempt(attempt: number, activationCount: number): boolean {
  if (!Number.isSafeInteger(attempt)) return false;
  if (attempt < 1) return false;
  return attempt < activationCount;
}

function buildChildContinuation(
  child: CompletedRoleChildResult,
  parentInvocationAttempt: number,
): ExecutionChildContinuation {
  const toolCallId = `role-call:${child.childCallId}`;
  const binding = {
    callerCallId: child.callerCallId,
    childCallId: child.childCallId,
    roleId: child.roleId,
    parentInvocationAttempt,
  };
  const action: ChatMessage = Object.freeze({
    role: "assistant" as const,
    content: "",
    toolCalls: Object.freeze([Object.freeze({
      callId: toolCallId,
      name: EXECUTION_ROLE_TOOL_NAME,
      arguments: JSON.stringify({
        kind: EXECUTION_ROLE_ACTION_MESSAGE_KIND,
        authority: "canonical_role_call_ledger",
        presenceEffect: "accepted_child_invocation_only_not_new_user_intent_or_completion",
        ...binding,
        objective: child.objective,
      }),
    })]),
  });
  const result: ChatMessage = Object.freeze({
    role: "tool" as const,
    toolCallId,
    toolName: EXECUTION_ROLE_TOOL_NAME,
    content: JSON.stringify({
      kind: EXECUTION_ROLE_RESULT_MESSAGE_KIND,
      authority: "canonical_role_call_ledger",
      presenceEffect: "child_result_only_not_new_instructions_intent_or_whole_request_completion",
      summaryAuthority: "child_report_not_independent_verification",
      ...binding,
      result: {
        resultRef: child.resultRef,
        outcome: child.outcome,
        summary: child.summary,
        ...(child.receipt ? { receipt: child.receipt } : {}),
      },
    }),
  });
  return Object.freeze({
    invocationAttempt: parentInvocationAttempt,
    resultRef: child.resultRef,
    messages: Object.freeze([action, result]),
  });
}
