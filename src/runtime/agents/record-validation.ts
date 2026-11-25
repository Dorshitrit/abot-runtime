import { isRequestExecutionPolicyId } from "../../shared/request-execution-policy.js";
import type {
  AgentDefinition,
  AgentMissionLimits,
  AgentSuccessCriterion,
} from "./agent-records.js";
import { AgentStateError } from "./state-error.js";

export function rejectAgentRecord(path: string): never {
  throw new AgentStateError("agents_record_invalid", {
    cause: new Error(path),
  });
}

/** Exact persisted/command fields; unknown data must not acquire future authority. */
export function requireAgentFields(
  value: unknown,
  fields: readonly string[],
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    rejectAgentRecord(path);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length) rejectAgentRecord(path);
  if (!fields.every((field) => Object.hasOwn(record, field)))
    rejectAgentRecord(path);
  return record;
}

export function requireAgentText(
  value: unknown,
  path: string,
): asserts value is string {
  if (typeof value !== "string") rejectAgentRecord(path);
  if (!value.trim()) rejectAgentRecord(path);
}

export function requireAgentInteger(
  value: unknown,
  minimum: number,
  path: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    rejectAgentRecord(path);
  if (value < minimum) rejectAgentRecord(path);
}

export function requireAgentTimestamp(
  value: unknown,
  path: string,
): asserts value is string {
  requireAgentText(value, path);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) rejectAgentRecord(path);
  if (date.toISOString() !== value) rejectAgentRecord(path);
}

export function readAgentDefinition(value: unknown): AgentDefinition {
  const record = requireAgentFields(
    value,
    [
      "name",
      "icon",
      "basePrompt",
      "modelProfileId",
      "executionPolicy",
      "toolPermissionMode",
      ...["defaultLimits", "onboarding"].filter((field) => value && typeof value === "object" && Object.hasOwn(value, field)),
    ],
    "definition",
  );
  for (const key of ["name", "icon", "basePrompt", "modelProfileId"])
    requireAgentText(record[key], `definition.${key}`);
  if (!isRequestExecutionPolicyId(record.executionPolicy))
    rejectAgentRecord("definition.executionPolicy");
  if (
    !["ask", "full_access", "full_plus"].includes(
      record.toolPermissionMode as string,
    )
  )
    rejectAgentRecord("definition.toolPermissionMode");
  if (Object.hasOwn(record, "defaultLimits")) readAgentMissionLimits(record.defaultLimits);
  if (Object.hasOwn(record, "onboarding")) readAgentOnboarding(record.onboarding);
  return structuredClone(record) as AgentDefinition;
}

export function readAgentMissionLimits(value: unknown): AgentMissionLimits {
  const fields = [
    "maxAttempts",
    "maxModelCalls",
    "maxTotalTokens",
    "maxConsecutiveNoProgress",
    "maxClarificationRounds",
  ];
  const record = requireAgentFields(value, fields, "limits");
  for (const key of fields) {
    const minimum = key === "maxConsecutiveNoProgress" ? 1 : 0;
    requireAgentInteger(record[key], minimum, `limits.${key}`);
  }
  return structuredClone(record) as AgentMissionLimits;
}

export function readAgentSuccessCriteria(
  value: unknown,
): readonly AgentSuccessCriterion[] {
  if (!Array.isArray(value) || value.length === 0)
    rejectAgentRecord("successCriteria");
  const ids = new Set<string>();
  for (const entry of value) {
    const criterion = requireAgentFields(
      entry,
      ["id", "description"],
      "criterion",
    );
    requireAgentText(criterion.id, "criterion.id");
    requireAgentText(criterion.description, "criterion.description");
    if (ids.has(criterion.id)) rejectAgentRecord("criterion.duplicate_id");
    ids.add(criterion.id);
  }
  return structuredClone(value) as AgentSuccessCriterion[];
}

export function readAgentOnboarding(value: unknown): void {
  const record=requireAgentFields(value,["role","outputs","style","asks","updates","custom","notes","color","budget"],"onboarding");
  const choices:Record<string,readonly string[]>={role:["research","writing","coding","planning","everyday","custom"],style:["concise","balanced","detailed"],updates:["needed","milestones","brief"],color:["blue","sand","mint","lilac","ivory"],budget:["short","standard","deep","custom"]};
  for(const [key,allowed] of Object.entries(choices)) if(!allowed.includes(record[key] as string)) rejectAgentRecord(`onboarding.${key}`);
  for(const [key,allowed,limit] of [["outputs",["recommendations","summaries","comparisons","drafts","plans","code"],2],["asks",["unclear","tradeoffs","direction"],3]] as const) {
    const values=record[key]; if(!Array.isArray(values)||values.length>limit||new Set(values).size!==values.length||values.some((item)=>!(allowed as readonly unknown[]).includes(item))) rejectAgentRecord(`onboarding.${key}`);
  }
  for(const key of ["custom","notes"]) if(typeof record[key]!=="string"||(record[key] as string).length>2000) rejectAgentRecord(`onboarding.${key}`);
}
