import { readAgentMissionLimits } from "./record-validation.js";
import type { AgentScheduleInput, AgentScheduleRecord, AgentScheduleState } from "./schedule-contracts.js";
import { AgentStateError } from "./state-error.js";
function fail(): never { throw new AgentStateError("agents_schedule_invalid"); }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max; }
function timestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
export function readAgentScheduleInput(value: unknown): AgentScheduleInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const input = value as AgentScheduleInput;
  if (!text(input.id, 160) || !/^[a-zA-Z0-9_-]+$/.test(input.id) || !text(input.agentId, 160) || !text(input.title, 200) || !text(input.text, 32_000)) fail();
  if (!timestamp(input.startAt) || !integer(input.maxOccurrences, 1, 1000)) fail();
  if (input.intervalMs === null ? input.maxOccurrences !== 1 : !integer(input.intervalMs, 60_000, 365 * 86_400_000)) fail();
  readAgentMissionLimits(input.limits);
  return structuredClone({ id: input.id, agentId: input.agentId, title: input.title, text: input.text, startAt: input.startAt,
    intervalMs: input.intervalMs, maxOccurrences: input.maxOccurrences, limits: input.limits });
}
export function readAgentScheduleState(value: unknown): AgentScheduleState {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  // Legacy coordinator identity is projected only; reads never rewrite the journal.
  const legacy = value as { schemaVersion?: unknown; schedules?: unknown };
  if (legacy.schemaVersion === 1) {
    if (!Array.isArray(legacy.schedules)) fail();
    value = { ...value, schemaVersion: 2, schedules: legacy.schedules.map((entry) =>
      entry && typeof entry === "object" ? { ...entry, agentId: entry.agentId === "spark" ? "abot" : entry.agentId } : entry) };
  }
  const state = value as AgentScheduleState;
  if (state.schemaVersion !== 2 || !integer(state.revision, 0) || !Array.isArray(state.schedules)) fail();
  const ids = new Set<string>();
  for (const record of state.schedules) {
    readAgentScheduleInput(record);
    if (ids.has(record.id)) fail(); ids.add(record.id);
    if (!integer(record.revision, 1) || !["active", "completed", "cancelled", "awaiting_user_decision"].includes(record.status)) fail();
    const binding = record.binding;
    if (!binding || !integer(binding.agentRevision, 1) || !text(binding.modelProfileId, 300) ||
      !["execution-agent-v1", "supervisor-worker-v1"].includes(binding.executionPolicy) || !["ask", "full_access", "full_plus"].includes(binding.toolPermissionMode)) fail();
    if (record.nextRunAt !== null && !timestamp(record.nextRunAt)) fail();
    if (record.status === "active" && record.nextRunAt === null && !record.occurrences?.some((entry) => entry.status === "claimed")) fail();
    if (!Array.isArray(record.occurrences) || record.occurrences.length > record.maxOccurrences) fail();
    for (const [index, occurrence] of record.occurrences.entries()) {
      if (occurrence.ordinal !== index + 1 || occurrence.messageId !== `agent-schedule:${record.id}:${index + 1}` ||
        !timestamp(occurrence.scheduledAt) || !timestamp(occurrence.createdAt) || !text(occurrence.reason, 1000) ||
        !["claimed", "accepted", "skipped", "unknown"].includes(occurrence.status)) fail();
      if (!occurrence.binding || !integer(occurrence.binding.agentRevision, 1) || !text(occurrence.binding.modelProfileId, 300) ||
        !["execution-agent-v1", "supervisor-worker-v1"].includes(occurrence.binding.executionPolicy) ||
        !["ask", "full_access", "full_plus"].includes(occurrence.binding.toolPermissionMode)) fail();
      if (occurrence.missionId !== null && !text(occurrence.missionId, 200)) fail();
      if (occurrence.status === "accepted" && occurrence.missionId === null) fail();
    }
  }
  return structuredClone(state);
}
export function requireAgentSchedule(state: AgentScheduleState, id: string, revision?: number, ownerId?: string): AgentScheduleRecord {
  const current = state.schedules.find((entry) => entry.id === id && (ownerId === undefined || entry.agentId === ownerId));
  if (!current) throw new AgentStateError("agents_schedule_not_found");
  if (revision !== undefined && (!integer(revision, 1) || current.revision !== revision)) throw new AgentStateError("agents_schedule_revision_conflict");
  return current;
}
