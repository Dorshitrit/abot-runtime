import type { ModelReasoningPreference } from "../../shared/model-reasoning.js";
import type { AgentMode } from "../../shared/types.js";
import type { AutomationJournalState } from "../automations/storage-records.js";
import type { SchedulerToolPermissionMode } from "./tool-permission-mode.js";
import type { SchedulerJobMutationGuard } from "./job-mutation-guard.js";

export type SchedulerScheduleInput =
  | { kind: "timer"; delayMs: number }
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number; anchorAt?: string }
  | { kind: "daily"; at: string }
  | { kind: "weekly"; at: string; weekdays: number[] }
  | { kind: "monthly"; at: string; dayOfMonth: number };
export type SchedulerAutomationScheduleInput =
  | SchedulerScheduleInput
  | { kind: "manual" };

export type SchedulerSchedule =
  | { kind: "manual" }
  | { kind: "timer"; delayMs: number; at: string }
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number; anchorAt: string }
  | { kind: "daily"; at: string }
  | { kind: "weekly"; at: string; weekdays: number[] }
  | { kind: "monthly"; at: string; dayOfMonth: number };
export type SchedulerTimedSchedule = Exclude<
  SchedulerSchedule,
  { kind: "manual" }
>;

export type SchedulerJobState = "active" | "paused" | "cancelled" | "completed";
export interface SchedulerJob {
  /** Legacy records omit this discriminator and are normalized when loaded. */
  target?: Readonly<{ kind: "request" }>;
  id: string;
  environmentId: string;
  sessionId: string;
  title: string;
  prompt: string;
  modelProfileId: string;
  agentMode: AgentMode;
  reasoningPreference?: ModelReasoningPreference;
  toolPermissionMode: SchedulerToolPermissionMode;
  timeZone: string;
  schedule: SchedulerTimedSchedule;
  state: SchedulerJobState;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  revision: number;
}
export interface SchedulerAutomationJob {
  id: string;
  environmentId: string;
  target: Readonly<{
    kind: "automation";
    automationId: string;
    definitionRevision: number;
  }>;
  title: string;
  timeZone: string;
  schedule: SchedulerSchedule;
  state: SchedulerJobState;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  revision: number;
}
export type SchedulerStoredJob = SchedulerJob | SchedulerAutomationJob;
export interface CreateAutomationSchedulerJobInput {
  automationId: string;
  definitionRevision: number;
  title: string;
  timeZone: string;
  schedule: SchedulerAutomationScheduleInput;
}
export type UpdateAutomationSchedulerJobInput = Partial<
  Omit<CreateAutomationSchedulerJobInput, "automationId">
>;
export interface CreateSchedulerJobInput {
  toolPermissionMode?: SchedulerToolPermissionMode;
  sessionId: string;
  title: string;
  prompt: string;
  modelProfileId: string;
  agentMode: AgentMode;
  reasoningPreference?: ModelReasoningPreference;
  timeZone: string;
  schedule: SchedulerScheduleInput;
}
export type UpdateSchedulerJobInput = Partial<
  Omit<CreateSchedulerJobInput, "sessionId" | "reasoningPreference">
> & { reasoningPreference?: ModelReasoningPreference | null };
export type SchedulerRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "missed";
export interface SchedulerRun {
  /** Legacy records omit this discriminator and are normalized when loaded. */
  target?: Readonly<{ kind: "request" }>;
  /** Omitted by historical runs, which always used Full. */
  toolPermissionMode?: SchedulerToolPermissionMode;
  id: string;
  jobId: string;
  environmentId: string;
  sessionId: string;
  requestId: string;
  title: string;
  prompt: string;
  modelProfileId: string;
  agentMode: AgentMode;
  reasoningPreference?: ModelReasoningPreference;
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
export interface SchedulerAutomationRun {
  id: string;
  jobId: string;
  environmentId: string;
  target: Readonly<{
    kind: "automation";
    automationId: string;
    definitionRevision: number;
  }>;
  title: string;
  timeZone: string;
  jobRevision: number;
  scheduledAt: string;
  /** Durable actual admission instant; old automation records fall back to scheduledAt. */
  admittedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  trigger: "schedule" | "manual";
  idempotencyKey?: string;
  replayOf?: string;
  status: SchedulerRunStatus | "stopping" | "completed_with_skips";
  error?: string;
  reportRef?: string;
}
export type SchedulerStoredRun = SchedulerRun | SchedulerAutomationRun;
export interface SchedulerAutomationRunOutcome {
  status: "succeeded" | "completed_with_skips" | "failed" | "cancelled";
  error?: string;
  reportRef?: string;
}
export interface SchedulerAutomationStartedRun {
  /** May resolve at the stop-report deadline before underlying effects settle. */
  outcome: Promise<SchedulerAutomationRunOutcome>;
  /** Admission remains reserved until every started effect actually settles. */
  resourcesSettled: Promise<void>;
}
export type PreparedAutomationOccurrence =
  | Readonly<{
      kind: "no_input";
      /** Commit source-baseline/observation metadata without creating a Run. */
      commit?(state: AutomationJournalState): void;
    }>
  | Readonly<{
      kind: "ready";
      inputIds: readonly string[];
      /** Pure durable-state mutation within the scheduler Run claim transaction. */
      commit(state: AutomationJournalState, runId: string): void;
      /** Dispose snapshots when a stale preparation never reaches the claim. */
      discard?(): Promise<void>;
    }>
  | Readonly<{
      kind: "failed";
      error: string;
      commit(state: AutomationJournalState, runId: string): void;
    }>;
export interface SchedulerAutomationExecutor {
  /** Recover internal transcripts under the journal lease before any dispatch. */
  reconcileSessions?(): Promise<void>;
  /** Existing scheduler tick drives bounded payload retention without a new timer. */
  maintainRetention?(now: number): Promise<void>;
  tryReserve(
    automationId: string,
  ): (() => void) | null | Promise<(() => void) | null>;
  prepare(
    job: SchedulerAutomationJob,
    candidateRunId: string,
    trigger: SchedulerAutomationRun["trigger"],
  ): Promise<PreparedAutomationOccurrence>;
  /** Reuse exact retained input versions without mutating the previous claim. */
  prepareReplay?(
    job: SchedulerAutomationJob,
    previousRun: SchedulerAutomationRun,
    candidateRunId: string,
  ): Promise<PreparedAutomationOccurrence>;
  start(
    job: SchedulerAutomationJob,
    run: SchedulerAutomationRun,
  ): SchedulerAutomationStartedRun;
  /** Signal a durable stop intent; remember it if start has not begun yet. */
  stop(runId: string): void;
  /** Synchronous state updates, committed atomically with scheduler recovery. */
  recover(
    scheduler: SchedulerSnapshot,
    automations: AutomationJournalState,
    recoveredRunIds: readonly string[],
  ): void;
  /** Synchronous report/reference update in the root terminal commit. */
  settle(
    run: SchedulerAutomationRun,
    automations: AutomationJournalState,
    outcome: SchedulerAutomationRunOutcome,
  ): void;
  /** Release never-dispatched claims and attach a derived report in one commit. */
  cancelPending(
    run: SchedulerAutomationRun,
    automations: AutomationJournalState,
    reason: "paused" | "republished" | "stopped",
  ): void;
}
export interface SchedulerRunOutcome {
  status: "succeeded" | "failed";
  resultText?: string;
  resultMessageId?: string;
  error?: string;
}
export interface SchedulerExecutor {
  sessionExists(sessionId: string): Promise<boolean>;
  tryReserve(
    sessionId: string,
  ): (() => void) | null | Promise<(() => void) | null>;
  start(job: SchedulerJob, run: SchedulerRun): Promise<SchedulerRunOutcome>;
}
export interface SchedulerSnapshot {
  schemaVersion: 1;
  jobs: SchedulerStoredJob[];
  runs: SchedulerStoredRun[];
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
    target?: "request" | "automation",
  ): Promise<SchedulerStoredRun[]>;
  readRun?(runId: string): Promise<SchedulerStoredRun | null>;
  readAutomationRunByKey?(
    automationId: string,
    idempotencyKey: string,
  ): Promise<SchedulerAutomationRun | null>;
  /** Compact journal-index count; no retained Run payload hydration. */
  countAutomationRunsOnDay?(
    automationId: string,
    timeZone: string,
    at: number,
  ): Promise<number>;
  /** The automation facet shares this store's owner lease and journal. */
  readAutomations?(): Promise<AutomationJournalState>;
  updateAutomations?<T>(
    mutate: (state: AutomationJournalState) => T,
  ): Promise<T>;
  updateWithAutomations?<T>(
    mutate: (
      scheduler: SchedulerSnapshot,
      automations: AutomationJournalState,
    ) => T,
    view?: "active",
  ): Promise<T>;
}
export interface SchedulerListFilter {
  sessionId?: string;
  state?: SchedulerJobState;
  search?: string;
}
export interface SchedulerRunListQuery {
  cursor?: string;
  status?: SchedulerStoredRun["status"];
  /** Scheduled instant range: inclusive from, exclusive to, with UTC offsets. */
  from?: string;
  to?: string;
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
  update(jobId: string, patch: UpdateSchedulerJobInput, guard?: SchedulerJobMutationGuard): Promise<SchedulerJob>;
  pause(jobId: string, guard?: SchedulerJobMutationGuard): Promise<SchedulerJob>;
  resume(jobId: string, guard?: SchedulerJobMutationGuard): Promise<SchedulerJob>;
  cancel(jobId: string, guard?: SchedulerJobMutationGuard): Promise<SchedulerJob>;
  runNow(jobId: string, guard?: SchedulerJobMutationGuard): Promise<SchedulerRun>;
  deleteSession(sessionId: string): Promise<void>;
  listRuns(
    jobId?: string,
    query?: SchedulerRunListQuery,
  ): Promise<SchedulerRun[]>;
  createAutomationJob(
    input: CreateAutomationSchedulerJobInput,
    commitPublication?: (
      state: AutomationJournalState,
      candidate: SchedulerAutomationJob,
    ) => void,
  ): Promise<SchedulerAutomationJob>;
  getAutomationJob(automationId: string): Promise<SchedulerAutomationJob | null>;
  listAutomationJobs(): Promise<SchedulerAutomationJob[]>;
  updateAutomationJob(
    jobId: string,
    patch: UpdateAutomationSchedulerJobInput,
    commitPublication?: (
      state: AutomationJournalState,
      candidate: SchedulerAutomationJob,
    ) => void,
  ): Promise<SchedulerAutomationJob>;
  pauseAutomationJob(jobId: string): Promise<SchedulerAutomationJob>;
  resumeAutomationJob(jobId: string): Promise<SchedulerAutomationJob>;
  runNowAutomation(
    jobId: string,
    options?: { idempotencyKey?: string },
  ): Promise<SchedulerAutomationRun>;
  rerunAutomationRun(
    previousRunId: string,
    options: {
      idempotencyKey: string;
      confirmed: true;
      preflight?(
        job: SchedulerAutomationJob,
        previousRun: SchedulerAutomationRun,
      ): Promise<void>;
      validateAdmission(
        state: AutomationJournalState,
        job: SchedulerAutomationJob,
        previousRun: SchedulerAutomationRun,
      ): void;
    },
  ): Promise<SchedulerAutomationRun>;
  stopAutomationRun(runId: string): Promise<SchedulerAutomationRun>;
  listAutomationRuns(
    automationId: string,
    query?: SchedulerRunListQuery,
  ): Promise<SchedulerAutomationRun[]>;
  getAutomationRun(runId: string): Promise<SchedulerAutomationRun | null>;
}
