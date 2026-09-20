import { exactKeys, isRecord } from "../../validation/strict-record.js";
import {
  areModelWorkPlanDefinitionsEqual,
  resolveModelWorkPlanSourceDefinition,
} from "./work-plan-source.js";
import type { DecodedRoleCallCommand } from "./command-decoder.js";
import type {
  RoleCallFrame,
  RoleCallPolicy,
  RoleCallState,
} from "./contracts.js";
import {
  MODEL_WORK_PLAN_ID_LIMIT,
  MODEL_WORK_PLAN_ITEM_LIMIT,
  MODEL_WORK_PLAN_STATUSES,
  MODEL_WORK_PLAN_TEXT_LIMIT,
  type AdoptedModelWorkPlan,
  type ModelWorkPlanDefinition,
  type ModelWorkPlanItemUpdate,
  type ModelWorkPlanUpdate,
} from "./work-plan-contracts.js";

export function isModelWorkPlanText(
  value: unknown,
  limit = MODEL_WORK_PLAN_TEXT_LIMIT,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= limit
  );
}

export function parseModelWorkPlanItemUpdates(
  value: unknown,
): readonly ModelWorkPlanItemUpdate[] | undefined {
  if (!Array.isArray(value) || value.length > MODEL_WORK_PLAN_ITEM_LIMIT)
    return undefined;
  const updates: ModelWorkPlanItemUpdate[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || !exactKeys(entry, ["itemId", "status"]))
      return undefined;
    if (!isModelWorkPlanText(entry.itemId, MODEL_WORK_PLAN_ID_LIMIT))
      return undefined;
    if (
      !MODEL_WORK_PLAN_STATUSES.includes(
        entry.status as ModelWorkPlanItemUpdate["status"],
      )
    )
      return undefined;
    if (ids.has(entry.itemId)) return undefined;
    ids.add(entry.itemId);
    updates.push({
      itemId: entry.itemId,
      status: entry.status as ModelWorkPlanItemUpdate["status"],
    });
  }
  return updates;
}

export function parseModelWorkPlanDefinition(
  value: unknown,
): ModelWorkPlanDefinition | undefined {
  if (!isRecord(value) || !exactKeys(value, ["summary", "items"]))
    return undefined;
  if (!isModelWorkPlanText(value.summary) || !Array.isArray(value.items))
    return undefined;
  if (
    value.items.length === 0 ||
    value.items.length > MODEL_WORK_PLAN_ITEM_LIMIT
  )
    return undefined;
  const items: ModelWorkPlanDefinition["items"][number][] = [];
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!isRecord(item) || !exactKeys(item, ["itemId", "title", "objective"]))
      return undefined;
    if (!isModelWorkPlanText(item.itemId, MODEL_WORK_PLAN_ID_LIMIT))
      return undefined;
    if (
      !isModelWorkPlanText(item.title) ||
      !isModelWorkPlanText(item.objective)
    )
      return undefined;
    if (ids.has(item.itemId)) return undefined;
    ids.add(item.itemId);
    items.push({
      itemId: item.itemId,
      title: item.title,
      objective: item.objective,
    });
  }
  return { summary: value.summary, items };
}

export function parseModelWorkPlanUpdate(
  value: unknown,
): ModelWorkPlanUpdate | undefined {
  if (!isRecord(value)) return undefined;
  if (!isModelWorkPlanText(value.sourceResultRef, 256)) return undefined;
  const itemUpdates = parseModelWorkPlanItemUpdates(value.itemUpdates);
  if (!itemUpdates) return undefined;
  if (value.mode === "progress") {
    if (
      !exactKeys(value, ["mode", "sourceResultRef", "itemUpdates"]) ||
      itemUpdates.length === 0
    )
      return undefined;
    return {
      mode: "progress",
      sourceResultRef: value.sourceResultRef,
      itemUpdates,
    };
  }
  if (value.mode !== "adopt") return undefined;
  if (
    !exactKeys(value, ["mode", "sourceResultRef", "definition", "itemUpdates"])
  )
    return undefined;
  const definition = parseModelWorkPlanDefinition(value.definition);
  if (!definition || !updatesNameKnownItems(definition, itemUpdates))
    return undefined;
  return {
    mode: "adopt",
    sourceResultRef: value.sourceResultRef,
    definition,
    itemUpdates,
  };
}

export function decodeModelWorkPlanCommand(
  input: Record<string, unknown>,
): DecodedRoleCallCommand {
  const invalid = { ok: false, code: "invalid_command" } as const;
  if (
    !exactKeys(input, [
      "authority",
      "type",
      "callId",
      "invocationAttempt",
      "update",
    ])
  )
    return invalid;
  if (
    input.authority !== "active_role" ||
    !isModelWorkPlanText(input.callId, 256)
  )
    return invalid;
  if (
    !Number.isSafeInteger(input.invocationAttempt) ||
    (input.invocationAttempt as number) < 1
  )
    return invalid;
  const update = parseModelWorkPlanUpdate(input.update);
  if (!update) return invalid;
  return {
    ok: true,
    value: {
      authority: "active_role",
      type: "update_model_work_plan",
      callId: input.callId,
      invocationAttempt: input.invocationAttempt as number,
      update,
    },
  };
}

export function updatesNameKnownItems(
  definition: ModelWorkPlanDefinition,
  updates: readonly ModelWorkPlanItemUpdate[],
): boolean {
  const ids = new Set(definition.items.map((item) => item.itemId));
  return updates.every((update) => ids.has(update.itemId));
}

export function isValidAdoptedModelWorkPlan(
  state: RoleCallState,
  call: RoleCallFrame,
  policy: RoleCallPolicy,
): boolean {
  const plan: AdoptedModelWorkPlan | undefined = call.adoptedWorkPlan;
  if (plan === undefined) return true;
  if (policy.authority.modelWorkPlanAuthority !== "root") return false;
  if (call.callId !== state.rootCallId || call.parentCallId !== null)
    return false;
  if (
    !isRecord(plan) ||
    !exactKeys(plan, ["sourceResultRef", "definition", "itemStates"])
  )
    return false;
  if (!isModelWorkPlanText(plan.sourceResultRef, 256)) return false;
  const source = resolveModelWorkPlanSourceDefinition(
    state,
    call,
    plan.sourceResultRef,
    policy,
  );
  if (!source) return false;
  const definition = parseModelWorkPlanDefinition(plan.definition);
  const states = parseModelWorkPlanItemUpdates(plan.itemStates);
  if (!definition || !states || definition.items.length !== states.length)
    return false;
  if (!areModelWorkPlanDefinitionsEqual(definition, source)) return false;
  return updatesNameKnownItems(definition, states);
}
