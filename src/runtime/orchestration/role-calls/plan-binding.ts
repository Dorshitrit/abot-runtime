import {
  type RoleCallFrame,
  type RoleCallPlanBinding,
  type RoleCallPlanState,
  type RoleCallPolicy,
  type RoleCallState,
  type RoleCallTransitionRejectionCode,
  type RoleCallValidationIssue,
} from "./contracts.js";
import {
  validateRoleCallPlanExtension,
  validateRoleCallPlanProposal,
} from "./plan-validation.js";
import {
  composeRoleCallPlanChildObjective,
  selectDefinedPlanItems,
  selectProposedPlanItems,
} from "./plan-child-objective.js";

type PlanBindingRejectionCode = Extract<
  RoleCallTransitionRejectionCode,
  | "planner_plan_binding_invalid"
  | "planner_plan_already_declared"
  | "planner_plan_missing"
  | "planner_plan_item_unavailable"
>;

export type RoleCallPlanBindingResult =
  | Readonly<{
      ok: true;
      plans: readonly RoleCallPlanState[];
      planItemIds?: readonly string[];
    }>
  | Readonly<{
      ok: false;
      code: PlanBindingRejectionCode;
      issues?: readonly RoleCallValidationIssue[];
    }>;

export type RoleCallPlanSettlementResult =
  | Readonly<{
      ok: true;
      plans: readonly RoleCallPlanState[];
      planItemIds?: readonly string[];
    }>
  | Readonly<{
      ok: false;
      code: "planner_plan_binding_invalid";
    }>;

export function bindRoleCallPlanChild(params: {
  state: RoleCallState;
  caller: RoleCallFrame;
  childCallId: string;
  childObjective: string;
  binding?: RoleCallPlanBinding;
  policy: RoleCallPolicy;
}): RoleCallPlanBindingResult {
  const existing = findPlannerPlan(params.state, params.caller.callId);
  if (!params.binding) {
    return params.caller.roleId === "planner" || existing
      ? { ok: false, code: "planner_plan_binding_invalid" }
      : { ok: true, plans: params.state.plans };
  }
  if (params.caller.roleId !== "planner") {
    return { ok: false, code: "planner_plan_binding_invalid" };
  }
  if (params.binding.mode === "declare") {
    const declaration = params.binding;
    if (existing) {
      return { ok: false, code: "planner_plan_already_declared" };
    }
    const issues = validateRoleCallPlanProposal({
      state: params.state,
      caller: params.caller,
      binding: declaration,
      childObjective: params.childObjective,
      policy: params.policy,
    });
    if (issues.length > 0) {
      return {
        ok: false,
        code: "planner_plan_binding_invalid",
        issues: Object.freeze(issues),
      };
    }
    const planId = `plan-${params.caller.callId}`;
    const items = declaration.plan.items.map((item, index) =>
      Object.freeze({
        itemId: `${planId}-item-${index + 1}`,
        title: item.title.trim(),
        objective: item.objective.trim(),
      }),
    );
    const selectedItems = selectProposedPlanItems(
      items,
      declaration.selectedItemIndexes,
    )!;
    const selectedItemIds = new Set(selectedItems.map((item) => item.itemId));
    const plan: RoleCallPlanState = Object.freeze({
      definition: Object.freeze({
        planId,
        plannerCallId: params.caller.callId,
        version: 1,
        summary: declaration.plan.summary.trim(),
        items: Object.freeze(items),
      }),
      itemStates: Object.freeze(
        items.map((item) =>
          Object.freeze({
            itemId: item.itemId,
            status: selectedItemIds.has(item.itemId)
              ? "in_progress"
              : "pending",
            childCallId: selectedItemIds.has(item.itemId)
              ? params.childCallId
              : null,
          }),
        ),
      ),
    });
    return {
      ok: true,
      plans: Object.freeze([...params.state.plans, plan]),
      planItemIds: Object.freeze(selectedItems.map((item) => item.itemId)),
    };
  }

  if (!existing) {
    return { ok: false, code: "planner_plan_missing" };
  }
  if (params.binding.mode === "extend") {
    const extension = params.binding;
    const issues = validateRoleCallPlanExtension({
      state: params.state,
      binding: extension,
      childObjective: params.childObjective,
      policy: params.policy,
      planItemStates: existing.itemStates,
    });
    if (issues.length > 0) {
      return {
        ok: false,
        code: "planner_plan_binding_invalid",
        issues: Object.freeze(issues),
      };
    }
    const firstNewItemIndex = existing.definition.items.length;
    const addedItems = extension.extension.items.map((item, index) =>
      Object.freeze({
        itemId: `${existing.definition.planId}-item-${
          firstNewItemIndex + index + 1
        }`,
        title: item.title.trim(),
        objective: item.objective.trim(),
      }),
    );
    const selectedItems = selectProposedPlanItems(
      addedItems,
      extension.selectedItemIndexes,
    )!;
    const selectedItemIds = new Set(selectedItems.map((item) => item.itemId));
    const replacement: RoleCallPlanState = Object.freeze({
      definition: Object.freeze({
        ...existing.definition,
        version: existing.definition.version + 1,
        items: Object.freeze([...existing.definition.items, ...addedItems]),
      }),
      itemStates: Object.freeze([
        ...existing.itemStates,
        ...addedItems.map((item) =>
          Object.freeze({
            itemId: item.itemId,
            status: selectedItemIds.has(item.itemId)
              ? ("in_progress" as const)
              : ("pending" as const),
            childCallId: selectedItemIds.has(item.itemId)
              ? params.childCallId
              : null,
          }),
        ),
      ]),
    });
    return {
      ok: true,
      plans: replacePlan(params.state.plans, replacement),
      planItemIds: Object.freeze(selectedItems.map((item) => item.itemId)),
    };
  }
  const definitions = selectDefinedPlanItems(
    existing.definition,
    params.binding.itemIds,
  );
  const selectedItemIds = new Set(
    definitions?.map((item) => item.itemId) ?? [],
  );
  if (
    !definitions ||
    composeRoleCallPlanChildObjective(
      definitions,
      params.policy.limits.maxObjectiveChars,
    ) !== params.childObjective.trim() ||
    definitions.some((definition) => {
      const state = existing.itemStates.find(
        (item) => item.itemId === definition.itemId,
      );
      return state?.status !== "pending" || state.childCallId !== null;
    })
  ) {
    return { ok: false, code: "planner_plan_item_unavailable" };
  }
  const replacement: RoleCallPlanState = Object.freeze({
    ...existing,
    itemStates: Object.freeze(
      existing.itemStates.map((item) =>
        selectedItemIds.has(item.itemId)
          ? Object.freeze({
              ...item,
              status: "in_progress" as const,
              childCallId: params.childCallId,
            })
          : item,
      ),
    ),
  });
  return {
    ok: true,
    plans: replacePlan(params.state.plans, replacement),
    planItemIds: Object.freeze(definitions.map((item) => item.itemId)),
  };
}

export function settleRoleCallPlanChild(params: {
  state: RoleCallState;
  caller: RoleCallFrame;
  childCallId: string;
  outcome: "completed" | "failed";
}): RoleCallPlanSettlementResult {
  const existing = findPlannerPlan(params.state, params.caller.callId);
  if (!existing) return { ok: true, plans: params.state.plans };
  const itemStates = existing.itemStates.filter(
    (item) => item.childCallId === params.childCallId,
  );
  if (
    itemStates.length === 0 ||
    itemStates.some((item) => item.status !== "in_progress")
  ) {
    return { ok: false, code: "planner_plan_binding_invalid" };
  }
  const replacement: RoleCallPlanState = Object.freeze({
    ...existing,
    itemStates: Object.freeze(
      existing.itemStates.map((item) =>
        item.childCallId === params.childCallId
          ? Object.freeze({
              ...item,
              status:
                params.outcome === "completed"
                  ? ("done" as const)
                  : ("blocked" as const),
            })
          : item,
      ),
    ),
  });
  return {
    ok: true,
    plans: replacePlan(params.state.plans, replacement),
    planItemIds: Object.freeze(itemStates.map((item) => item.itemId)),
  };
}

export function plannerPlanHasOpenItems(
  plans: readonly RoleCallPlanState[],
  plannerCallId: string,
): boolean {
  const plan = plans.find(
    (candidate) => candidate.definition.plannerCallId === plannerCallId,
  );
  return (
    plan?.itemStates.some(
      (item) => item.status === "pending" || item.status === "in_progress",
    ) ?? false
  );
}

function findPlannerPlan(
  state: RoleCallState,
  plannerCallId: string,
): RoleCallPlanState | undefined {
  return state.plans.find(
    (plan) => plan.definition.plannerCallId === plannerCallId,
  );
}

function replacePlan(
  plans: readonly RoleCallPlanState[],
  replacement: RoleCallPlanState,
): readonly RoleCallPlanState[] {
  return Object.freeze(
    plans.map((plan) =>
      plan.definition.planId === replacement.definition.planId
        ? replacement
        : plan,
    ),
  );
}
