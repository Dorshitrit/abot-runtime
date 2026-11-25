import { isDeepStrictEqual } from "node:util";
import type { AgentRecord } from "./agent-records.js";
import type { AgentApplicationDetail } from "./application-contracts.js";
import type { AgentScheduleBinding, AgentScheduleOccurrence, AgentScheduleRecord, AgentScheduleState } from "./schedule-contracts.js";
import { AgentStateError } from "./state-error.js";
export function scheduleBinding(agent: AgentRecord): AgentScheduleBinding {
  return { agentRevision: agent.revision, modelProfileId: agent.definition.modelProfileId,
    executionPolicy: agent.definition.executionPolicy, toolPermissionMode: agent.definition.toolPermissionMode };
}
export function scheduleBindingMatches(schedule: AgentScheduleRecord, detail: AgentApplicationDetail): boolean {
  return isDeepStrictEqual(schedule.binding, scheduleBinding(detail.agent));
}
export function replaceSchedule(state: AgentScheduleState, record: AgentScheduleRecord): AgentScheduleRecord {
  const next = { ...record, revision: record.revision + 1 };
  state.schedules = state.schedules.map((entry) => entry.id === record.id ? next : entry);
  return next;
}
export function scheduleHasUnresolvedClaim(record: AgentScheduleRecord): boolean {
  return record.occurrences.some((entry) => entry.status === "claimed" || entry.status === "unknown");
}
export function addScheduleOccurrence(record: AgentScheduleRecord, now: number, status: "claimed" | "skipped", reason: string): AgentScheduleRecord {
  if (!record.nextRunAt || record.occurrences.length >= record.maxOccurrences) throw new AgentStateError("agents_schedule_not_due");
  const ordinal = record.occurrences.length + 1;
  const occurrence: AgentScheduleOccurrence = { ordinal, messageId: `agent-schedule:${record.id}:${ordinal}`,
    scheduledAt: record.nextRunAt, status, reason, missionId: null, createdAt: new Date(now).toISOString(), binding: record.binding };
  const nextTime = record.intervalMs === null ? null : Date.parse(record.nextRunAt) + record.intervalMs;
  if (nextTime !== null && !Number.isFinite(new Date(nextTime).getTime())) throw new AgentStateError("agents_schedule_date_invalid");
  const nextRunAt = ordinal >= record.maxOccurrences || nextTime === null ? null : new Date(nextTime).toISOString();
  return { ...record, occurrences: [...record.occurrences, occurrence], nextRunAt,
    status: nextRunAt === null && status === "skipped" ? "completed" : "active" };
}
export function acceptedScheduleMission(record: AgentScheduleRecord, occurrence: AgentScheduleOccurrence, detail: AgentApplicationDetail): string | null {
  const message = detail.messages.find((entry) => entry.id === occurrence.messageId);
  if (!message) return null;
  if (message.agentId !== record.agentId || message.text !== record.text || message.role !== "user" || message.source !== null)
    throw new AgentStateError("agents_schedule_message_conflict");
  if (detail.mission?.id === message.missionId && (detail.mission.agentId !== record.agentId ||
    detail.mission.objective !== record.text || !isDeepStrictEqual(detail.mission.limits, record.limits)))
    throw new AgentStateError("agents_schedule_mission_conflict");
  return message.missionId;
}
