import type { AgentMode } from "../../shared/types.js";

export type SchedulerScheduleInput =
  | { kind: "timer"; delayMs: number }
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number; anchorAt?: string }
  | { kind: "daily"; at: string }
  | { kind: "weekly"; at: string; weekdays: number[] }
  | { kind: "monthly"; at: string; dayOfMonth: number };

export type SchedulerSchedule =
  | { kind: "timer"; delayMs: number; at: string }
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number; anchorAt: string }
  | { kind: "daily"; at: string }
  | { kind: "weekly"; at: string; weekdays: number[] }
  | { kind: "monthly"; at: string; dayOfMonth: number };

export type SchedulerJobState = "active" | "paused" | "cancelled" | "completed";
export interface SchedulerJob {
  id: string;
  environmentId: string;
  sessionId: string;
  title: string;
  prompt: string;
  modelProfileId: string;
  agentMode: AgentMode;
  toolPermissionMode: "full_access";
  timeZone: string;
  schedule: SchedulerSchedule;
  state: SchedulerJobState;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  revision: number;
}
export interface CreateSchedulerJobInput {
  sessionId: string;
  title: string;
  prompt: string;
  modelProfileId: string;
  agentMode: AgentMode;
  timeZone: string;
  schedule: SchedulerScheduleInput;
}
export type UpdateSchedulerJobInput = Partial<
  Omit<CreateSchedulerJobInput, "sessionId">
>;
export type SchedulerRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "missed";
export interface SchedulerRun {
  id: string;
  jobId: string;
  environmentId: string;
  sessionId: string;
  requestId: string;
  title: string;
  prompt: string;
  modelProfileId: string;
  agentMode: AgentMode;
  timeZone: string;
  jobRevision: number;
  scheduledAt: string;
  startedAt?: string;
  finishedAt?: string;
  trigger: "schedule" | "manual";
  status: SchedulerRunStatus;
  resultText?: string;
  resultMessageId?: string;
  error?: string;
}
export interface SchedulerRunOutcome {
  status: "succeeded" | "failed";
  resultText?: string;
  resultMessageId?: string;
  error?: string;
}
export interface SchedulerExecutor {
  sessionExists(sessionId: string): Promise<boolean>;
  tryReserve(sessionId: string): (() => void) | null;
  start(job: SchedulerJob, run: SchedulerRun): Promise<SchedulerRunOutcome>;
}
export interface SchedulerSnapshot {
  schemaVersion: 1;
  jobs: SchedulerJob[];
  runs: SchedulerRun[];
}
export interface SchedulerStore {
  acquire(): Promise<() => Promise<void>>;
  read(view?: "active"): Promise<SchedulerSnapshot>;
  update<T>(
    mutate: (state: SchedulerSnapshot) => T,
    view?: "active",
  ): Promise<T>;
  readRuns?(
    jobId?: string,
    query?: SchedulerRunListQuery,
  ): Promise<SchedulerRun[]>;
}
export interface SchedulerListFilter {
  sessionId?: string;
  state?: SchedulerJobState;
  search?: string;
}
export interface SchedulerRunListQuery {
  cursor?: string;
  /** Bounded newest-first results; 101 allows a 100-record page plus lookahead. */
  limit: number;
}
export interface SchedulerService {
  start(): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
  create(input: CreateSchedulerJobInput): Promise<SchedulerJob>;
  list(filter?: SchedulerListFilter): Promise<SchedulerJob[]>;
  get(jobId: string): Promise<SchedulerJob | null>;
  update(jobId: string, patch: UpdateSchedulerJobInput): Promise<SchedulerJob>;
  pause(jobId: string): Promise<SchedulerJob>;
  resume(jobId: string): Promise<SchedulerJob>;
  cancel(jobId: string): Promise<SchedulerJob>;
  runNow(jobId: string): Promise<SchedulerRun>;
  deleteSession(sessionId: string): Promise<void>;
  listRuns(
    jobId?: string,
    query?: SchedulerRunListQuery,
  ): Promise<SchedulerRun[]>;
}
