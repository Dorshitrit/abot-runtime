import {
  ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallPlanBinding,
  type RoleCallPolicy,
  type RoleCallState,
  type RoleCallValidationIssue,
} from "./contracts.js";
import {
  composeRoleCallPlanChildObjective,
  selectProposedPlanItems,
} from "./plan-child-objective.js";

export function validateRoleCallPlanProposal(params: {
  state: RoleCallState;
  caller: RoleCallFrame;
  binding: Extract<RoleCallPlanBinding, { mode: "declare" }>;
  childObjective: string;
  policy: RoleCallPolicy;
}): RoleCallValidationIssue[] {
  const issues: RoleCallValidationIssue[] = [];
  const remainingCallCapacity =
    params.policy.limits.maxCalls - params.state.calls.length;
  if (
    params.caller.activationCount !== 1 ||
    params.caller.childCallIds.length !== 0 ||
    !isBoundedText(
      params.binding.plan.summary,
      params.policy.limits.maxObjectiveChars,
    ) ||
    params.binding.plan.items.length === 0 ||
    params.binding.plan.items.length > remainingCallCapacity ||
    !selectProposedPlanItems(
      params.binding.plan.items,
      params.binding.selectedItemIndexes,
    )
  ) {
    issues.push(
      issue("planner_plan_declaration_invalid", "command.plannerPlan"),
    );
    return issues;
  }
  for (const [index, item] of params.binding.plan.items.entries()) {
    if (
      !isBoundedText(item.title, ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH) ||
      !isBoundedText(item.objective, params.policy.limits.maxObjectiveChars)
    ) {
      issues.push(
        issue(
          "planner_plan_item_invalid",
          `command.plannerPlan.plan.items.${index}`,
        ),
      );
    }
  }
  const selected = selectProposedPlanItems(
    params.binding.plan.items,
    params.binding.selectedItemIndexes,
  );
  if (
    !selected ||
    composeRoleCallPlanChildObjective(
      selected,
      params.policy.limits.maxObjectiveChars,
    ) !== params.childObjective.trim()
  ) {
    issues.push(
      issue("planner_plan_selected_objective_mismatch", "command.objective"),
    );
  }
  return issues;
}

export function validateRoleCallPlanExtension(params: {
  state: RoleCallState;
  binding: Extract<RoleCallPlanBinding, { mode: "extend" }>;
  childObjective: string;
  policy: RoleCallPolicy;
  planItemStates: readonly Readonly<{ status: string }>[];
}): RoleCallValidationIssue[] {
  const issues: RoleCallValidationIssue[] = [];
  const remainingCallCapacity =
    params.policy.limits.maxCalls - params.state.calls.length;
  if (
    params.planItemStates.some(
      (item) => item.status === "pending" || item.status === "in_progress",
    ) ||
    params.binding.extension.items.length === 0 ||
    params.binding.extension.items.length > remainingCallCapacity ||
    !selectProposedPlanItems(
      params.binding.extension.items,
      params.binding.selectedItemIndexes,
    )
  ) {
    issues.push(issue("planner_plan_extension_invalid", "command.plannerPlan"));
    return issues;
  }
  for (const [index, item] of params.binding.extension.items.entries()) {
    if (
      !isBoundedText(item.title, ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH) ||
      !isBoundedText(item.objective, params.policy.limits.maxObjectiveChars)
    ) {
      issues.push(
        issue(
          "planner_plan_item_invalid",
          `command.plannerPlan.extension.items.${index}`,
        ),
      );
    }
  }
  const selected = selectProposedPlanItems(
    params.binding.extension.items,
    params.binding.selectedItemIndexes,
  );
  if (
    !selected ||
    composeRoleCallPlanChildObjective(
      selected,
      params.policy.limits.maxObjectiveChars,
    ) !== params.childObjective.trim()
  ) {
    issues.push(
      issue("planner_plan_selected_objective_mismatch", "command.objective"),
    );
  }
  return issues;
}

export function validateRoleCallPlans(
  state: RoleCallState,
  policy: RoleCallPolicy,
): readonly RoleCallValidationIssue[] {
  if (!Array.isArray(state.plans)) {
    return [issue("invalid_role_call_plans", "state.plans")];
  }
  const issues: RoleCallValidationIssue[] = [];
  const plannerCallIds = new Set<string>();
  const planIds = new Set<string>();
  for (const [planIndex, plan] of state.plans.entries()) {
    const path = `state.plans.${planIndex}`;
    const planner = state.calls.find(
      (call) => call.callId === plan?.definition?.plannerCallId,
    );
    const definitions = plan?.definition?.items;
    const itemStates = plan?.itemStates;
    if (
      !planner ||
      planner.roleId !== "planner" ||
      plan.definition.planId !== `plan-${planner.callId}` ||
      !Number.isSafeInteger(plan.definition.version) ||
      plan.definition.version < 1 ||
      plan.definition.version > plan.definition.items.length ||
      plannerCallIds.has(planner.callId) ||
      planIds.has(plan.definition.planId) ||
      !isBoundedText(
        plan.definition.summary,
        policy.limits.maxObjectiveChars,
      ) ||
      !Array.isArray(definitions) ||
      definitions.length === 0 ||
      definitions.length > policy.limits.maxCalls ||
      !Array.isArray(itemStates) ||
      itemStates.length !== definitions.length
    ) {
      issues.push(issue("invalid_role_call_plan", path));
      continue;
    }
    plannerCallIds.add(planner.callId);
    planIds.add(plan.definition.planId);
    const boundChildCallIds = new Set<string>();
    const groups = new Map<
      string,
      Array<{
        definition: (typeof definitions)[number];
        state: (typeof itemStates)[number];
        path: string;
      }>
    >();
    for (const [itemIndex, definition] of definitions.entries()) {
      const itemPath = `${path}.items.${itemIndex}`;
      const itemState = itemStates[itemIndex];
      const expectedItemId = `${plan.definition.planId}-item-${itemIndex + 1}`;
      if (
        definition.itemId !== expectedItemId ||
        !isBoundedText(
          definition.title,
          ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH,
        ) ||
        !isBoundedText(definition.objective, policy.limits.maxObjectiveChars) ||
        itemState?.itemId !== definition.itemId ||
        !["pending", "in_progress", "done", "blocked"].includes(
          itemState.status,
        )
      ) {
        issues.push(issue("invalid_role_call_plan_item", itemPath));
        continue;
      }
      if (itemState.status === "pending") {
        if (itemState.childCallId !== null) {
          issues.push(issue("invalid_role_call_plan_item", itemPath));
        }
        continue;
      }
      if (typeof itemState.childCallId !== "string") {
        issues.push(issue("invalid_role_call_plan_item_status", itemPath));
        continue;
      }
      const group = groups.get(itemState.childCallId) ?? [];
      group.push({ definition, state: itemState, path: itemPath });
      groups.set(itemState.childCallId, group);
    }
    let activeGroupCount = 0;
    for (const [childCallId, group] of groups) {
      const child = state.calls.find((call) => call.callId === childCallId);
      const result = state.results.find(
        (entry) => entry.resultRef === child?.resultRef,
      );
      const statuses = new Set(group.map((entry) => entry.state.status));
      const composedObjective = composeRoleCallPlanChildObjective(
        group.map((entry) => entry.definition),
        policy.limits.maxObjectiveChars,
      );
      if (
        !child ||
        child.parentCallId !== planner.callId ||
        composedObjective === undefined ||
        child.objective !== composedObjective ||
        statuses.size !== 1
      ) {
        for (const entry of group) {
          issues.push(issue("invalid_role_call_plan_item_binding", entry.path));
        }
        continue;
      }
      boundChildCallIds.add(child.callId);
      const status = group[0]!.state.status;
      const validStatus =
        status === "in_progress"
          ? child.status !== "completed" && child.resultRef === null
          : (status === "done" || status === "blocked") &&
            child.status === "completed" &&
            result?.producerCallId === child.callId &&
            (status === "done"
              ? result.outcome === "completed"
              : result.outcome === "failed");
      if (status === "in_progress") activeGroupCount += 1;
      if (!validStatus) {
        for (const entry of group) {
          issues.push(issue("invalid_role_call_plan_item_status", entry.path));
        }
      }
    }
    if (
      activeGroupCount > 1 ||
      planner.childCallIds.some(
        (childCallId) => !boundChildCallIds.has(childCallId),
      )
    ) {
      issues.push(issue("invalid_role_call_plan_progress", path));
    }
  }
  return issues;
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength
  );
}

function issue(code: string, path: string): RoleCallValidationIssue {
  return { code, path };
}
