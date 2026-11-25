import type { AgentMissionLimits, AgentRecord } from "./agent-records.js";
import type { AgentApplicationService } from "./application-contracts.js";

export type AgentScheduleInput = Readonly<{
  id: string; agentId: string; title: string; text: string; startAt: string;
  intervalMs: number | null; maxOccurrences: number; limits: AgentMissionLimits;
}>;
export type AgentScheduleUpdate = Omit<AgentScheduleInput, "id" | "agentId">;
export type AgentScheduleBinding = Readonly<{
  agentRevision: number; modelProfileId: string; executionPolicy: AgentRecord["definition"]["executionPolicy"];
  toolPermissionMode: AgentRecord["definition"]["toolPermissionMode"];
}>;
export type AgentScheduleOccurrence = Readonly<{
  ordinal: number; messageId: string; scheduledAt: string;
  status: "claimed" | "accepted" | "skipped" | "unknown";
  reason: string; missionId: string | null; createdAt: string; binding: AgentScheduleBinding;
}>;
export type AgentScheduleRecord = AgentScheduleInput & Readonly<{
  revision: number; binding: AgentScheduleBinding;
  status: "active" | "completed" | "cancelled" | "awaiting_user_decision";
  nextRunAt: string | null; occurrences: readonly AgentScheduleOccurrence[];
}>;
export type AgentScheduleState = { schemaVersion: 2; revision: number; schedules: AgentScheduleRecord[] };
export type AgentScheduleService = Readonly<{
  list(agentId?: string): Promise<readonly AgentScheduleRecord[]>;
  create(input: AgentScheduleInput): Promise<AgentScheduleRecord>;
  update(id: string, expectedRevision: number, input: AgentScheduleUpdate, ownerId?: string): Promise<AgentScheduleRecord>;
  cancel(id: string, expectedRevision: number, ownerId?: string): Promise<AgentScheduleRecord>;
  removeForAgent(agentId: string): Promise<void>;
  start(): Promise<void>; stop(): Promise<void>; tick(): Promise<void>;
}>;
export type AgentScheduleDependencies = Readonly<{
  filename: string; application: Pick<AgentApplicationService, "detail" | "send">;
  runTick?: (operation: () => Promise<void>) => Promise<void>;
  now?: () => number; onError?: (error: unknown) => void;
}>;
/** Online timer jitter allowance only. Startup always skips elapsed deadlines. */
export const AGENT_SCHEDULE_MAX_LATENESS_MS = 30_000;
