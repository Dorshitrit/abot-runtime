import type { AgentDefinition, AgentState } from "./agent-records.js";
import type { AgentControllerCommand } from "./controller-commands.js";
import type { AgentDecisionConfiguration } from "./decision-records.js";
import { readAgentDecisionConfiguration } from "./decision-validation.js";
import type { AgentInvocationCost, AgentInvocationRecord, AgentInvocationStage, AgentInvocationUsage } from "./invocation-records.js";
import { rejectAgentRecord, requireAgentFields, requireAgentInteger, requireAgentText, requireAgentTimestamp } from "./record-validation.js";

export type AgentInvocationCommand = Extract<AgentControllerCommand, { kind: "reserve_invocation" | "settle_invocation" }>;
const STAGES: readonly AgentInvocationStage[] = ["assessment", "selection", "assessment_and_selection", "authoring", "repair", "progress_report"];

function readInvocationStage(value: unknown): AgentInvocationStage {
  if (!STAGES.includes(value as AgentInvocationStage)) rejectAgentRecord("invocation.stage");
  return value as AgentInvocationStage;
}

export function isAgentInvocationStageAllowed(stage: AgentInvocationStage, configuration: AgentDecisionConfiguration): boolean {
  if (stage === "authoring" || stage === "repair" || stage === "progress_report") return true;
  if (configuration.policy.id === "supervisor-worker-v1")
    return stage === "assessment" || stage === "selection";
  return stage === "assessment_and_selection";
}

export function matchesAgentInvocationConfiguration(configuration: AgentDecisionConfiguration, definition: AgentDefinition): boolean {
  if (configuration.modelProfileId !== definition.modelProfileId) return false;
  if (configuration.policy.id !== definition.executionPolicy) return false;
  return configuration.toolPermissionMode === definition.toolPermissionMode;
}

function readInvocationCost(value: unknown): AgentInvocationCost {
  if (value === null || typeof value !== "object" || Array.isArray(value)) rejectAgentRecord("invocation.cost");
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "unknown") return requireAgentFields(value, ["kind"], "invocation.cost") as AgentInvocationCost;
  const cost = requireAgentFields(value, ["kind", "amount", "currency", "source"], "invocation.cost");
  if (kind !== "actual" && kind !== "estimated") rejectAgentRecord("invocation.cost.kind");
  if (typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount < 0)
    rejectAgentRecord("invocation.cost.amount");
  requireAgentText(cost.currency, "invocation.cost.currency");
  requireAgentText(cost.source, "invocation.cost.source");
  return structuredClone(cost) as AgentInvocationCost;
}

function readInvocationUsage(value: unknown): AgentInvocationUsage | null {
  if (value === null) return null;
  const usage = requireAgentFields(value, ["totalTokens", "cost"], "invocation.usage");
  requireAgentInteger(usage.totalTokens, 0, "invocation.usage.totalTokens");
  return { totalTokens: usage.totalTokens, cost: readInvocationCost(usage.cost) };
}

export function readAgentInvocationCommand(value: unknown): AgentInvocationCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) rejectAgentRecord("invocation.command");
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "settle_invocation") {
    const hasReport = Object.hasOwn(value, "progressReport");
    const command = requireAgentFields(value, ["kind", "agentId", "invocationId", "usage", ...(hasReport ? ["progressReport"] : [])], "invocation.command");
    if (hasReport) {
      const report = requireAgentFields(command.progressReport, ["workId", "text"], "invocation.progressReport");
      requireAgentText(report.workId, "invocation.progressReport.workId");
      requireAgentText(report.text, "invocation.progressReport.text");
      if (report.text.length > 360 || !command.usage) rejectAgentRecord("invocation.progressReport");
    }
    requireAgentText(command.agentId, "invocation.agentId");
    requireAgentText(command.invocationId, "invocation.id");
    readInvocationUsage(command.usage);
    return structuredClone(command) as Extract<AgentInvocationCommand, { kind: "settle_invocation" }>;
  }
  if (kind !== "reserve_invocation") rejectAgentRecord("invocation.command.kind");
  const command = requireAgentFields(value, ["kind", "agentId", "missionId", "invocationId", "agentRevision",
    "missionRevision", "configuration", "stage", "reservedTokens"], "invocation.command");
  for (const key of ["agentId", "missionId", "invocationId"]) requireAgentText(command[key], `invocation.${key}`);
  for (const key of ["agentRevision", "missionRevision", "reservedTokens"]) requireAgentInteger(command[key], 1, `invocation.${key}`);
  readAgentDecisionConfiguration(command.configuration);
  readInvocationStage(command.stage);
  return structuredClone(command) as AgentInvocationCommand;
}

export function validateAgentInvocationRecord(value: unknown): asserts value is AgentInvocationRecord {
  const record = requireAgentFields(value, ["id", "agentId", "missionId", "agentRevision", "missionRevision",
    "configuration", "stage", "reservedTokens", "status", "usage", "createdAt", "updatedAt",
    ...(value && typeof value === "object" && Object.hasOwn(value,"publicUpdate") ? ["publicUpdate"] : [])], "invocation");
  for (const key of ["id", "agentId", "missionId"]) requireAgentText(record[key], `invocation.${key}`);
  for (const key of ["agentRevision", "missionRevision", "reservedTokens"]) requireAgentInteger(record[key], 1, `invocation.${key}`);
  const configuration = readAgentDecisionConfiguration(record.configuration);
  const stage = readInvocationStage(record.stage);
  if (stage === "progress_report" && record.id !== `progress:${record.missionId}`) rejectAgentRecord("invocation.progress_identity");
  if (Object.hasOwn(record, "publicUpdate")) {
    requireAgentText(record.publicUpdate, "invocation.publicUpdate");
    if (record.publicUpdate.length > 360 || stage !== "progress_report" || record.status !== "settled") rejectAgentRecord("invocation.publicUpdate");
  }
  if (!isAgentInvocationStageAllowed(stage, configuration)) rejectAgentRecord("invocation.stage_policy");
  if (!["reserved", "usage_unknown", "settled"].includes(record.status as string)) rejectAgentRecord("invocation.status");
  const usage = readInvocationUsage(record.usage);
  if (record.status === "settled" && usage === null) rejectAgentRecord("invocation.settled_usage_missing");
  if (record.status !== "settled" && usage !== null) rejectAgentRecord("invocation.unsettled_usage_present");
  requireAgentTimestamp(record.createdAt, "invocation.createdAt");
  requireAgentTimestamp(record.updatedAt, "invocation.updatedAt");
}

function addValidatedUsage(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) rejectAgentRecord("invocation.usage_overflow");
  return result;
}

/** Original configuration is historical; only an equal live Agent revision must still match it. */
export function validateAgentInvocationState(state: AgentState): void {
  const ids = new Set<string>();
  const pending = new Set<string>();
  const totals = new Map<string, { calls: number; tokens: number; reservedTokens: number }>();
  for (const record of state.invocations) {
    validateAgentInvocationRecord(record);
    if (ids.has(record.id)) rejectAgentRecord("invocation.duplicate_id");
    ids.add(record.id);
    const agent = state.agents.find((entry) => entry.id === record.agentId);
    const mission = state.missions.find((entry) => entry.id === record.missionId);
    if (!agent || !mission) rejectAgentRecord("invocation.owner_missing");
    if (mission.agentId !== record.agentId) rejectAgentRecord("invocation.mission_owner_mismatch");
    if (record.agentRevision > agent.revision) rejectAgentRecord("invocation.agent_revision_future");
    if (record.missionRevision > mission.revision) rejectAgentRecord("invocation.mission_revision_future");
    if (record.agentRevision === agent.revision && !matchesAgentInvocationConfiguration(record.configuration, agent.definition))
      rejectAgentRecord("invocation.configuration_mismatch");
    const total = totals.get(mission.id) ?? { calls: 0, tokens: 0, reservedTokens: 0 };
    total.calls = addValidatedUsage(total.calls, 1);
    total.tokens = addValidatedUsage(total.tokens, record.usage?.totalTokens ?? 0);
    totals.set(mission.id, total);
    if (record.status === "settled") continue;
    if (pending.has(mission.id)) rejectAgentRecord("invocation.multiple_pending");
    pending.add(mission.id);
    total.reservedTokens = addValidatedUsage(total.reservedTokens, record.reservedTokens);
  }
  for (const [missionId, total] of totals) {
    const mission = state.missions.find((entry) => entry.id === missionId)!;
    if (mission.usage.modelCalls < total.calls) rejectAgentRecord("invocation.model_calls_undercharged");
    if (mission.usage.totalTokens < total.tokens) rejectAgentRecord("invocation.tokens_undercharged");
    addValidatedUsage(mission.usage.totalTokens, total.reservedTokens);
  }
}
