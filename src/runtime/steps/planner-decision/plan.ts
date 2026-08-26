import {
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallLedger,
} from "../../orchestration/role-calls/index.js";
import type { PlannerDecisionPlanContext } from "./contracts.js";

export function normalizePlannerDecisionPlanContext(
  input: PlannerDecisionPlanContext,
): PlannerDecisionPlanContext {
  if (
    input.mode === "declare" &&
    Number.isSafeInteger(input.maxItems) &&
    input.maxItems >= 0
  ) {
    return Object.freeze({ mode: "declare", maxItems: input.maxItems });
  }
  if (
    input.mode === "extend" &&
    /^plan-call-[1-9][0-9]*$/u.test(input.planId) &&
    isBoundedText(input.summary, ROLE_CALL_OBJECTIVE_MAX_LENGTH) &&
    Number.isSafeInteger(input.existingItemCount) &&
    input.existingItemCount >= 1 &&
    Number.isSafeInteger(input.maxItems) &&
    input.maxItems >= 0
  ) {
    return Object.freeze({
      mode: "extend",
      planId: input.planId,
      summary: input.summary.trim(),
      existingItemCount: input.existingItemCount,
      maxItems: input.maxItems,
    });
  }
  if (
    input.mode !== "select" ||
    !/^plan-call-[1-9][0-9]*$/u.test(input.planId) ||
    !isBoundedText(input.summary, ROLE_CALL_OBJECTIVE_MAX_LENGTH) ||
    typeof input.childInvocationAvailable !== "boolean" ||
    !Array.isArray(input.pendingItems)
  ) {
    throw new Error("planner_plan_context_invalid");
  }
  const itemIds = new Set<string>();
  const pendingItems = input.pendingItems.map((item) => {
    if (
      !new RegExp(`^${input.planId}-item-[1-9][0-9]*$`, "u").test(
        item.itemId,
      ) ||
      itemIds.has(item.itemId) ||
      !isBoundedText(item.title, ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH) ||
      !isBoundedText(item.objective, ROLE_CALL_OBJECTIVE_MAX_LENGTH)
    ) {
      throw new Error("planner_plan_context_invalid");
    }
    itemIds.add(item.itemId);
    return Object.freeze({
      itemId: item.itemId,
      title: item.title.trim(),
      objective: item.objective.trim(),
    });
  });
  return Object.freeze({
    mode: "select",
    planId: input.planId,
    summary: input.summary.trim(),
    childInvocationAvailable: input.childInvocationAvailable,
    pendingItems: Object.freeze(pendingItems),
  });
}

export function plannerPlanAllowsInvocation(
  context: PlannerDecisionPlanContext | undefined,
): boolean {
  if (!context) return true;
  if (context.mode === "declare" || context.mode === "extend") {
    return context.maxItems > 0;
  }
  return context.childInvocationAvailable && context.pendingItems.length > 0;
}

export function projectPlannerDecisionPlanContext(
  params: Readonly<{
    ledger: RoleCallLedger;
    call: RoleCallFrame;
  }>,
): PlannerDecisionPlanContext {
  const head = params.ledger.current();
  const canonicalCall = head.state.calls.find(
    (candidate) => candidate.callId === params.call.callId,
  );
  if (
    head.state.phase !== "running" ||
    head.state.activeCallId !== params.call.callId ||
    canonicalCall !== params.call ||
    params.call.roleId !== "planner"
  ) {
    throw new Error("planner_plan_context_source_invalid");
  }
  const plan = head.state.plans.find(
    (candidate) => candidate.definition.plannerCallId === params.call.callId,
  );
  if (!plan) {
    if (params.call.childCallIds.length > 0) {
      throw new Error("planner_plan_context_missing");
    }
    return Object.freeze({
      mode: "declare",
      maxItems: Math.max(
        0,
        params.call.depth >= head.policy.limits.maxDepth
          ? 0
          : head.policy.limits.maxCalls - head.state.calls.length,
      ),
    });
  }
  const stateByItemId = new Map(
    plan.itemStates.map((item) => [item.itemId, item]),
  );
  const pendingItems = plan.definition.items.flatMap((item) => {
    const state = stateByItemId.get(item.itemId);
    if (!state) {
      throw new Error("planner_plan_context_source_invalid");
    }
    return state.status === "pending"
      ? [
          Object.freeze({
            itemId: item.itemId,
            title: item.title,
            objective: item.objective,
          }),
        ]
      : [];
  });
  if (plan.itemStates.some((item) => item.status === "in_progress")) {
    throw new Error("planner_plan_context_source_invalid");
  }
  const remainingItemCapacity = Math.max(
    0,
    params.call.depth >= head.policy.limits.maxDepth
      ? 0
      : head.policy.limits.maxCalls - head.state.calls.length,
  );
  if (pendingItems.length === 0) {
    return Object.freeze({
      mode: "extend",
      planId: plan.definition.planId,
      summary: plan.definition.summary,
      existingItemCount: plan.definition.items.length,
      maxItems: remainingItemCapacity,
    });
  }
  return Object.freeze({
    mode: "select",
    planId: plan.definition.planId,
    summary: plan.definition.summary,
    childInvocationAvailable: remainingItemCapacity > 0,
    pendingItems: Object.freeze(pendingItems),
  });
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength
  );
}
