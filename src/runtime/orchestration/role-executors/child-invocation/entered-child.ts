import { isDeepStrictEqual } from "node:util";
import type { RoleCallFrame, RoleCallLedger } from "../../role-calls/index.js";
import { isRuntimeDelegateRoleId } from "../../roles.js";
import type {
  EnteredChildCursor,
  RoleApprovalContinuation,
} from "../approval-continuation.js";
import type { RoleChildInvocationInput } from "../contracts.js";
import type { DelegateRoleCallFrame } from "./state-validation.js";

export type EnteredChild = Readonly<{
  call: DelegateRoleCallFrame;
  callerCall: RoleCallFrame;
  cursor: EnteredChildCursor;
}>;

export function restoreEnteredChild(
  ledger: RoleCallLedger,
  cursor: EnteredChildCursor,
): EnteredChild {
  const state = ledger.current().state;
  const caller = state.calls.find(
    (call) => call.callId === cursor.callerCall.callId,
  );
  const child = state.calls.find((call) => call.callId === cursor.childCallId);
  if (caller?.status !== "waiting_for_child")
    throw new Error("role_approval_caller_not_waiting");
  if (caller.childCallIds.at(-1) !== cursor.childCallId)
    throw new Error("role_approval_child_order_invalid");
  const priorCaller = {
    ...caller,
    status: "active",
    childCallIds: caller.childCallIds.slice(0, -1),
  };
  if (!isDeepStrictEqual(priorCaller, cursor.callerCall))
    throw new Error("role_approval_caller_identity_invalid");
  if (child?.parentCallId !== caller.callId)
    throw new Error("role_approval_child_parent_invalid");
  if (!isRuntimeDelegateRoleId(child.roleId))
    throw new Error("role_approval_child_role_invalid");
  if (child.status === "completed")
    throw new Error("role_approval_child_already_returned");
  if (!Number.isSafeInteger(cursor.turnCount) || cursor.turnCount < 1)
    throw new Error("role_approval_turn_invalid");
  const planItems = state.plans.flatMap((plan) =>
    plan.itemStates
      .filter((item) => item.childCallId === child.callId)
      .map((item) => item.itemId),
  );
  if (!isDeepStrictEqual(planItems, cursor.planItemIds ?? []))
    throw new Error("role_approval_plan_binding_invalid");
  return {
    call: child as DelegateRoleCallFrame,
    callerCall: cursor.callerCall,
    cursor,
  };
}

/** Both root and delegate callers re-enter the original child transaction. */
export function createEnteredChildInvocation<TContext, TValue>(params: {
  requestId: string;
  context: TContext;
  ledger: RoleCallLedger;
  continuation: RoleApprovalContinuation;
}): RoleChildInvocationInput<TContext> & { allowApprovalWait: true } {
  const cursor = params.continuation.callers[0];
  if (!cursor) throw new Error("role_approval_child_cursor_missing");
  const entered = restoreEnteredChild(params.ledger, cursor);
  return {
    allowApprovalWait: true,
    requestId: params.requestId,
    context: params.context,
    ledger: params.ledger,
    callerCall: cursor.callerCall,
    expectedHead: params.ledger.current(),
    roleId: entered.call.roleId,
    objective: entered.call.objective!,
    turnCount: cursor.turnCount,
    entered: params.continuation,
  };
}
