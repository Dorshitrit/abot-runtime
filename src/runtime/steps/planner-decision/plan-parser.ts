import {
  ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH,
  composeRoleCallPlanChildObjective,
  type RoleCallPlanBinding,
} from "../../orchestration/role-calls/index.js";
import {
  PLANNER_DISPATCH_ITEM_COUNT,
  PLANNER_OBJECTIVE_MAX_LENGTH,
  type PlannerDecisionPlanContext,
  type PlannerDecisionValidationIssue,
} from "./contracts.js";

export type PlannerPlanInvocation = Readonly<{
  objective: string;
  plannerPlan: RoleCallPlanBinding;
}>;

export function parsePlannerPlanInvocation(
  record: Record<string, unknown>,
  planContext: PlannerDecisionPlanContext,
  issues: PlannerDecisionValidationIssue[],
): PlannerPlanInvocation | undefined {
  const dispatchItemCount =
    record.roleId === "worker" ? PLANNER_DISPATCH_ITEM_COUNT : undefined;
  if (planContext.mode === "declare") {
    return parseDeclaration(
      record,
      planContext.maxItems,
      dispatchItemCount,
      issues,
    );
  }
  if (planContext.mode === "extend") {
    return parseExtension(
      record,
      planContext.maxItems,
      dispatchItemCount,
      issues,
    );
  }
  const selectedItems = parseSelectedPlanItems(
    record.planItemIds,
    planContext.pendingItems,
    dispatchItemCount,
  );
  const objective = selectedItems
    ? composeRoleCallPlanChildObjective(
        selectedItems,
        PLANNER_OBJECTIVE_MAX_LENGTH,
      )
    : undefined;
  if (!selectedItems || !objective) {
    issues.push(issue("planner_plan_item_unavailable", "decision.planItemIds"));
    return undefined;
  }
  return {
    objective,
    plannerPlan: Object.freeze({
      mode: "select",
      itemIds: Object.freeze(selectedItems.map((item) => item.itemId)),
    }),
  };
}

function parseDeclaration(
  record: Record<string, unknown>,
  maxItems: number,
  dispatchItemCount: number | undefined,
  issues: PlannerDecisionValidationIssue[],
): PlannerPlanInvocation | undefined {
  const plan = asRecord(record.plan);
  if (!plan) {
    issues.push(issue("planner_plan_invalid", "decision.plan"));
    return undefined;
  }
  exactKeys(plan, ["summary", "items"], issues, "decision.plan");
  validateBoundedText(
    plan.summary,
    PLANNER_OBJECTIVE_MAX_LENGTH,
    "planner_plan_summary_invalid",
    "decision.plan.summary",
    issues,
  );
  const items = parseItems(plan.items, maxItems, "decision.plan.items", issues);
  const selectedItemIndexes = items
    ? parseSelectedItemIndexes(
        record.selectedItemIndexes,
        items.length,
        dispatchItemCount,
      )
    : undefined;
  const selectedItems =
    items && selectedItemIndexes
      ? selectedItemIndexes.map((index) => items[index]!)
      : undefined;
  const objective = selectedItems
    ? composeRoleCallPlanChildObjective(
        selectedItems,
        PLANNER_OBJECTIVE_MAX_LENGTH,
      )
    : undefined;
  if (
    issues.length > 0 ||
    typeof plan.summary !== "string" ||
    !items ||
    !selectedItemIndexes ||
    !objective
  ) {
    if (!selectedItemIndexes || !objective) {
      issues.push(
        issue("planner_plan_item_unavailable", "decision.selectedItemIndexes"),
      );
    }
    return undefined;
  }
  return {
    objective,
    plannerPlan: Object.freeze({
      mode: "declare",
      plan: Object.freeze({
        summary: plan.summary.trim(),
        items,
      }),
      selectedItemIndexes,
    }),
  };
}

function parseExtension(
  record: Record<string, unknown>,
  maxItems: number,
  dispatchItemCount: number | undefined,
  issues: PlannerDecisionValidationIssue[],
): PlannerPlanInvocation | undefined {
  const extension = asRecord(record.extension);
  if (!extension) {
    issues.push(issue("planner_plan_extension_invalid", "decision.extension"));
    return undefined;
  }
  exactKeys(extension, ["items"], issues, "decision.extension");
  const items = parseItems(
    extension.items,
    maxItems,
    "decision.extension.items",
    issues,
  );
  const selectedItemIndexes = items
    ? parseSelectedItemIndexes(
        record.selectedItemIndexes,
        items.length,
        dispatchItemCount,
      )
    : undefined;
  const selectedItems =
    items && selectedItemIndexes
      ? selectedItemIndexes.map((index) => items[index]!)
      : undefined;
  const objective = selectedItems
    ? composeRoleCallPlanChildObjective(
        selectedItems,
        PLANNER_OBJECTIVE_MAX_LENGTH,
      )
    : undefined;
  if (issues.length > 0 || !items || !selectedItemIndexes || !objective) {
    if (!selectedItemIndexes || !objective) {
      issues.push(
        issue("planner_plan_item_unavailable", "decision.selectedItemIndexes"),
      );
    }
    return undefined;
  }
  return {
    objective,
    plannerPlan: Object.freeze({
      mode: "extend",
      extension: Object.freeze({ items }),
      selectedItemIndexes,
    }),
  };
}

function parseSelectedItemIndexes(
  input: unknown,
  itemCount: number,
  dispatchItemCount: number | undefined,
): readonly number[] | undefined {
  if (
    !Array.isArray(input) ||
    !hasValidSelectionCount(input.length, dispatchItemCount) ||
    input.some(
      (value) =>
        !Number.isSafeInteger(value) || value < 0 || value >= itemCount,
    ) ||
    new Set(input).size !== input.length
  ) {
    return undefined;
  }
  const selected = new Set(input as number[]);
  return Object.freeze(
    Array.from({ length: itemCount }, (_value, index) => index).filter(
      (index) => selected.has(index),
    ),
  );
}

function parseSelectedPlanItems<TItem extends Readonly<{ itemId: string }>>(
  input: unknown,
  items: readonly TItem[],
  dispatchItemCount: number | undefined,
): readonly TItem[] | undefined {
  if (
    !Array.isArray(input) ||
    !hasValidSelectionCount(input.length, dispatchItemCount) ||
    input.some((value) => typeof value !== "string") ||
    new Set(input).size !== input.length
  ) {
    return undefined;
  }
  const selected = new Set(input as string[]);
  const result = items.filter((item) => selected.has(item.itemId));
  return result.length === selected.size ? Object.freeze(result) : undefined;
}

function hasValidSelectionCount(
  selectedItemCount: number,
  dispatchItemCount: number | undefined,
): boolean {
  return dispatchItemCount === undefined
    ? selectedItemCount > 0
    : selectedItemCount === dispatchItemCount;
}

function parseItems(
  value: unknown,
  maxItems: number,
  pathPrefix: string,
  issues: PlannerDecisionValidationIssue[],
): readonly Readonly<{ title: string; objective: string }>[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) {
    issues.push(issue("planner_plan_items_invalid", pathPrefix));
    return undefined;
  }
  const items: Array<{ title: string; objective: string }> = [];
  for (const [index, valueItem] of value.entries()) {
    const item = asRecord(valueItem);
    const path = `${pathPrefix}.${index}`;
    if (!item) {
      issues.push(issue("planner_plan_item_invalid", path));
      continue;
    }
    exactKeys(item, ["title", "objective"], issues, path);
    validateBoundedText(
      item.title,
      ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH,
      "planner_plan_item_title_invalid",
      `${path}.title`,
      issues,
    );
    validateBoundedText(
      item.objective,
      PLANNER_OBJECTIVE_MAX_LENGTH,
      "planner_objective_invalid",
      `${path}.objective`,
      issues,
    );
    if (
      typeof item.title === "string" &&
      item.title.trim().length > 0 &&
      item.title.length <= ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH &&
      typeof item.objective === "string" &&
      item.objective.trim().length > 0 &&
      item.objective.length <= PLANNER_OBJECTIVE_MAX_LENGTH
    ) {
      items.push({
        title: item.title.trim(),
        objective: item.objective.trim(),
      });
    }
  }
  return items.length === value.length
    ? Object.freeze(items.map((item) => Object.freeze(item)))
    : undefined;
}

function exactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  issues: PlannerDecisionValidationIssue[],
  path: string,
): void {
  const expected = new Set(expectedKeys);
  const actual = Object.keys(record);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    issues.push(issue("planner_decision_shape_invalid", path));
  }
}

function validateBoundedText(
  value: unknown,
  maximumLength: number,
  code: string,
  path: string,
  issues: PlannerDecisionValidationIssue[],
): void {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    typeof value !== "string" ||
    normalized.length === 0 ||
    value.length > maximumLength
  ) {
    issues.push(issue(code, path));
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function issue(code: string, path: string): PlannerDecisionValidationIssue {
  return {
    code,
    path,
    message: `Planner decision failed ${code}.`,
  };
}
