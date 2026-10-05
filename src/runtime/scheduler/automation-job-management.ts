import { randomUUID } from "node:crypto";
import { requireUnarchivedAutomation } from "../automations/archive-management.js";
import { publishedAutomationScheduleTiming } from "../automations/trigger-schedule.js";
import type {
  AutomationExecutionRecord,
  AutomationJournalState,
} from "../automations/storage-records.js";
import type {
  CreateAutomationSchedulerJobInput,
  SchedulerAutomationJob,
  SchedulerAutomationRun,
  SchedulerSnapshot,
  UpdateAutomationSchedulerJobInput,
} from "./contracts.js";
import { normalizeAutomationSchedule, requireAutomationScheduleOccurrence, hasAutomationScheduleTimingChanged } from "./automation-schedule.js";
import type { AutomationScheduleTiming } from "./automation-schedule.js";
import { hasReachedAutomationDailyRunLimit } from "./automation-run-budget.js";
import {
  findPendingAutomationRun,
  hasActiveAutomationRun,
  makeAutomationSchedulerRun,
  requireAutomationSchedulerJob,
} from "./automation-run-records.js";
import { nextSchedulerOccurrence } from "./next-occurrence.js";
import {
  canBeginSchedulerRun,
  invalidateJob,
  jobEpoch,
  requireRunningScheduler,
  type SchedulerContext,
} from "./service-context.js";
import { validateTimeZone } from "./schedule-validation.js";
import {
  isAutomationSchedulerJob,
  isAutomationSchedulerRun,
} from "./scheduler-target.js";

type PublicationCommit = (
  state: AutomationJournalState,
  candidate: SchedulerAutomationJob,
) => void;

function requireAutomationJournalUpdate(context: SchedulerContext) {
  const update = context.store.updateWithAutomations;
  if (!update) throw new Error("automation_store_unavailable");
  return update;
}

function requireAutomationExecutor(context: SchedulerContext) {
  const executor = context.automationExecutor;
  if (!executor) throw new Error("automation_executor_unavailable");
  return executor;
}

function requireAutomationJobInput(
  input: CreateAutomationSchedulerJobInput,
): void {
  if (!input.automationId?.trim()) throw new Error("automation_invalid_job");
  if (!input.title?.trim()) throw new Error("automation_invalid_job");
  if (!Number.isSafeInteger(input.definitionRevision))
    throw new Error("automation_invalid_job");
  if (input.definitionRevision < 1) throw new Error("automation_invalid_job");
  validateTimeZone(input.timeZone);
}

export function createAutomationSchedulerJob(
  context: SchedulerContext,
  input: CreateAutomationSchedulerJobInput,
  commitPublication?: PublicationCommit,
): Promise<SchedulerAutomationJob> {
  return context.enqueue(async () => {
    requireRunningScheduler(context);
    requireAutomationJobInput(input);
    const now = context.now();
    const schedule = normalizeAutomationSchedule(input.schedule, now);
    const nextRunAt = requireAutomationScheduleOccurrence(schedule, input.timeZone, now);
    const job: SchedulerAutomationJob = {
      id: randomUUID(),
      environmentId: context.environmentId,
      target: {
        kind: "automation",
        automationId: input.automationId,
        definitionRevision: input.definitionRevision,
      },
      title: input.title.trim(),
      timeZone: input.timeZone,
      schedule,
      state: "paused",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      nextRunAt,
      revision: 1,
    };
    const update = requireAutomationJournalUpdate(context);
    return update((scheduler, automations) => {
      requireUnarchivedAutomation(automations, input.automationId);
      if (hasAutomationJob(scheduler, input.automationId))
        throw new Error("automation_job_exists");
      commitPublication?.(automations, job);
      scheduler.jobs.push(job);
      return job;
    });
  });
}

function hasAutomationJob(
  scheduler: SchedulerSnapshot,
  automationId: string,
): boolean {
  return scheduler.jobs.some(
    (job) =>
      isAutomationSchedulerJob(job) &&
      job.target.automationId === automationId,
  );
}

export function updateAutomationSchedulerJob(
  context: SchedulerContext,
  jobId: string,
  patch: UpdateAutomationSchedulerJobInput,
  commitPublication?: PublicationCommit,
): Promise<SchedulerAutomationJob> {
  const settleInvalidation = invalidateJob(context, jobId);
  return context
    .enqueue(async () => {
      requireRunningScheduler(context);
      const update = requireAutomationJournalUpdate(context);
      return update((scheduler, automations) => {
        const job = requireAutomationSchedulerJob(scheduler, jobId);
        requireUnarchivedAutomation(automations, job.target.automationId);
        if (job.state === "cancelled")
          throw new Error("scheduler_job_cancelled");
        const now = context.now();
        const draft = automations.drafts.find((item) => item.automationId === job.target.automationId &&
          item.revision === patch.definitionRevision);
        const previousTiming = commitPublication
          ? publishedAutomationScheduleTiming(automations, job, draft?.definition.trigger) : undefined;
        const candidate = updatedAutomationJob(job, patch, now, previousTiming);
        commitPublication?.(automations, candidate);
        if (JSON.stringify(candidate) === JSON.stringify(job)) return job;
        cancelPendingAutomationRuns(
          context,
          scheduler,
          automations,
          jobId,
          now,
          "republished",
        );
        Object.assign(job, candidate);
        return job;
      });
    })
    .finally(settleInvalidation);
}

function updatedAutomationJob(
  job: SchedulerAutomationJob,
  patch: UpdateAutomationSchedulerJobInput,
  now: number,
  previousTiming?: AutomationScheduleTiming,
): SchedulerAutomationJob {
  const title = patch.title ?? job.title;
  const timeZone = patch.timeZone ?? job.timeZone;
  const definitionRevision =
    patch.definitionRevision ?? job.target.definitionRevision;
  requireAutomationJobInput({
    automationId: job.target.automationId,
    title,
    timeZone,
    definitionRevision,
    schedule: patch.schedule ?? job.schedule,
  });
  if (definitionRevision < job.target.definitionRevision)
    throw new Error("automation_definition_revision_regressed");
  const schedule = patch.schedule
    ? normalizeAutomationSchedule(patch.schedule, now, previousTiming)
    : job.schedule;
  const timingChanged = hasAutomationScheduleTimingChanged(schedule, timeZone, job);
  const nextRunAt = timingChanged
    ? requireAutomationScheduleOccurrence(schedule, timeZone, now)
    : job.nextRunAt;
  const changed =
    title !== job.title ||
    timeZone !== job.timeZone ||
    definitionRevision !== job.target.definitionRevision ||
    timingChanged;
  if (!changed) return job;
  return {
    ...job,
    target: { ...job.target, definitionRevision },
    title: title.trim(),
    timeZone,
    schedule,
    nextRunAt,
    updatedAt: new Date(now).toISOString(),
    revision: job.revision + 1,
    state: job.state === "completed" && timingChanged ? "active" : job.state,
  };
}

function cancelPendingAutomationRuns(
  context: SchedulerContext,
  scheduler: SchedulerSnapshot,
  automations: AutomationJournalState,
  jobId: string,
  now: number,
  reason: "paused" | "republished" | "stopped",
): void {
  const at = new Date(now).toISOString();
  for (const run of scheduler.runs) {
    if (run.jobId !== jobId || run.status !== "pending") continue;
    if (!isAutomationSchedulerRun(run)) continue;
    requireAutomationExecutor(context).cancelPending(run, automations, reason);
    const execution = requireCommittedAutomationExecution(automations, run.id);
    if (!execution.reportRef) throw new Error("automation_report_missing");
    run.status = "cancelled";
    run.reportRef = execution.reportRef;
    run.finishedAt = at;
  }
}

export function changeAutomationSchedulerJobState(
  context: SchedulerContext,
  jobId: string,
  target: "active" | "paused",
): Promise<SchedulerAutomationJob> {
  const settleInvalidation = invalidateJob(context, jobId);
  return context
    .enqueue(async () => {
      requireRunningScheduler(context);
      const update = requireAutomationJournalUpdate(context);
      return update((scheduler, automations) => {
        const job = requireAutomationSchedulerJob(scheduler, jobId);
        if (job.state === "cancelled")
          throw new Error("scheduler_job_cancelled");
        const now = context.now();
        if (target === "active")
          requireUnarchivedAutomation(automations, job.target.automationId);
        if (target === "paused") {
          cancelPendingAutomationRuns(
            context,
            scheduler,
            automations,
            jobId,
            now,
            "paused",
          );
        }
        if (job.state === target) return job;
        job.state = target;
        job.updatedAt = new Date(now).toISOString();
        job.revision += 1;
        if (target !== "active") return job;
        job.nextRunAt = nextSchedulerOccurrence(job.schedule, job.timeZone, now);
        if (hasExhaustedAutomationSchedule(job)) job.state = "completed";
        return job;
      });
    })
    .finally(settleInvalidation);
}

function hasExhaustedAutomationSchedule(job: SchedulerAutomationJob): boolean {
  if (job.schedule.kind === "manual") return false;
  return job.nextRunAt === null;
}

export function requestAutomationSchedulerRunNow(
  context: SchedulerContext,
  jobId: string,
  options?: { idempotencyKey?: string },
): Promise<SchedulerAutomationRun> {
  return context.enqueue(async () => {
    requireRunningScheduler(context);
    const idempotencyKey = options?.idempotencyKey;
    if (idempotencyKey !== undefined &&
        (!idempotencyKey || idempotencyKey.length > 128))
      throw new Error("automation_idempotency_key_invalid");
    const scheduler = await context.store.read();
    const job = requireAutomationSchedulerJob(scheduler, jobId);
    if (job.state === "cancelled") throw new Error("scheduler_job_cancelled");
    if (!context.store.readAutomations) throw new Error("automation_store_unavailable");
    requireUnarchivedAutomation(await context.store.readAutomations(), job.target.automationId);
    if (idempotencyKey) {
      const readByKey = context.store.readAutomationRunByKey;
      if (!readByKey) throw new Error("automation_idempotency_unavailable");
      const previous = await readByKey(job.target.automationId, idempotencyKey);
      if (previous) {
        if (previous.replayOf || previous.jobId !== job.id ||
            previous.target.definitionRevision !== job.target.definitionRevision)
          throw new Error("automation_idempotency_conflict");
        return previous;
      }
    }
    const pending = findPendingAutomationRun(scheduler, jobId);
    if (pending) {
      if (idempotencyKey) throw new Error("automation_run_active");
      return pending;
    }
    if (hasActiveAutomationRun(scheduler, job.target.automationId))
      throw new Error("automation_run_active");
    const executor = requireAutomationExecutor(context);
    const candidateId = randomUUID();
    const epoch = jobEpoch(context, jobId);
    const prepared = await executor.prepare(job, candidateId, "manual");
    if (prepared.kind === "no_input") {
      if (prepared.commit) {
        const update = requireAutomationJournalUpdate(context);
        await update((current, automations) => {
          if (!canBeginSchedulerRun(context, jobId, epoch))
            throw new Error("automation_job_changed");
          const live = requireAutomationSchedulerJob(current, jobId);
          requireUnarchivedAutomation(automations, live.target.automationId);
          if (live.revision !== job.revision)
            throw new Error("automation_job_changed");
          prepared.commit?.(automations);
        });
      }
      throw new Error("automation_no_eligible_input");
    }
    let claimed = false;
    try {
      const update = requireAutomationJournalUpdate(context);
      if (await hasReachedAutomationDailyRunLimit(context, job, context.now()))
        throw new Error("automation_budget_exhausted");
      const run = await update((current, automations) => {
        if (!canBeginSchedulerRun(context, jobId, epoch))
          throw new Error("automation_job_changed");
        const live = requireAutomationSchedulerJob(current, jobId);
        requireUnarchivedAutomation(automations, live.target.automationId);
        if (live.revision !== job.revision)
          throw new Error("automation_job_changed");
        if (hasActiveAutomationRun(current, live.target.automationId))
          throw new Error("automation_run_active");
        const run = makeAutomationSchedulerRun(
          live,
          candidateId,
          new Date(context.now()).toISOString(),
          "manual",
          idempotencyKey,
        );
        prepared.commit(automations, run.id);
        const execution = requireCommittedAutomationExecution(automations, run.id);
        if (prepared.kind === "failed") {
          if (!execution.reportRef) throw new Error("automation_report_missing");
          run.status = "failed";
          run.error = prepared.error;
          run.reportRef = execution.reportRef;
          run.finishedAt = new Date(context.now()).toISOString();
          live.state = "paused";
          live.updatedAt = run.finishedAt;
          live.revision += 1;
        }
        current.runs.push(run);
        return run;
      });
      claimed = true;
      return run;
    } finally {
      if (!claimed && prepared.kind === "ready") await prepared.discard?.();
    }
  });
}

export function requireCommittedAutomationExecution(
  state: AutomationJournalState,
  runId: string,
): AutomationExecutionRecord {
  const execution = state.executions.find((item) => item.id === runId);
  if (!execution) throw new Error("automation_execution_checkpoint_missing");
  return execution;
}
