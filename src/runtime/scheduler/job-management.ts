import { randomUUID } from "node:crypto";
import type {
  CreateSchedulerJobInput,
  SchedulerJob,
  SchedulerJobState,
  SchedulerListFilter,
  SchedulerRun,
  UpdateSchedulerJobInput,
} from "./contracts.js";
import { nextSchedulerOccurrence } from "./next-occurrence.js";
import { normalizeSchedulerScheduleUpdate } from "./schedule-update.js";
import { requireRepresentableIntervalRecurrence } from "./interval-range.js";
import {
  cancelPendingRuns,
  findPendingRun,
  makeSchedulerRun,
  requireSchedulerJob,
} from "./run-records.js";
import {
  normalizeSchedulerSchedule,
  validateSchedulerJobInput,
} from "./schedule-validation.js";
import {
  invalidateJob,
  requireRunningScheduler,
  type SchedulerContext,
} from "./service-context.js";

export function createSchedulerJob(
  context: SchedulerContext,
  input: CreateSchedulerJobInput,
): Promise<SchedulerJob> {
  return context.enqueue(async () => {
    requireRunningScheduler(context);
    validateSchedulerJobInput(input);
    await requireExistingSession(context, input.sessionId);
    const now = context.now();
    const schedule = normalizeSchedulerSchedule(input.schedule, now);
    requireRepresentableIntervalRecurrence(schedule, now);
    const nextRunAt = nextSchedulerOccurrence(schedule, input.timeZone, now);
    if (!nextRunAt) throw new Error("scheduler_schedule_in_past");
    const job: SchedulerJob = {
      id: randomUUID(),
      environmentId: context.environmentId,
      sessionId: input.sessionId,
      title: input.title.trim(),
      prompt: input.prompt,
      modelProfileId: input.modelProfileId,
      agentMode: input.agentMode,
      toolPermissionMode: "full_access",
      timeZone: input.timeZone,
      schedule,
      state: "active",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      nextRunAt,
      revision: 1,
    };
    return context.store.update((state) => {
      if (context.deletedSessions.has(job.sessionId))
        throw new Error("scheduler_session_deleted");
      state.jobs.push(job);
      return job;
    });
  });
}
export function updateSchedulerJob(
  context: SchedulerContext,
  jobId: string,
  patch: UpdateSchedulerJobInput,
): Promise<SchedulerJob> {
  const settleInvalidation = invalidateJob(context, jobId);
  return context
    .enqueue(async () => {
      requireRunningScheduler(context);
      return context.store.update((state) => {
        const job = requireSchedulerJob(state, jobId);
        if (job.state === "cancelled")
          throw new Error("scheduler_job_cancelled");
        const editable = pickEditableFields(patch);
        const input = { ...job, ...editable };
        validateSchedulerJobInput(input);
        const now = context.now();
        const schedule = normalizeSchedulerScheduleUpdate(
          job.schedule,
          editable.schedule,
          now,
        );
        const candidate = { ...input, schedule };
        if (!hasSchedulerJobChanges(job, candidate)) return job;
        const changedTiming = hasSchedulerTimingChanges(job, candidate);
        if (changedTiming)
          requireRepresentableIntervalRecurrence(schedule, now);
        const nextRunAt = changedTiming
          ? nextSchedulerOccurrence(schedule, input.timeZone, now)
          : job.nextRunAt;
        if (changedTiming && !nextRunAt)
          throw new Error("scheduler_schedule_in_past");
        const pending = findPendingRun(state, jobId);
        cancelPendingRuns(state, jobId, new Date(now).toISOString());
        Object.assign(job, editable, {
          schedule,
          nextRunAt,
          toolPermissionMode: "full_access",
          updatedAt: new Date(now).toISOString(),
          revision: job.revision + 1,
        });
        if (changedTiming && job.state === "completed") job.state = "active";
        if (pending && !changedTiming) {
          state.runs.push(
            makeSchedulerRun(job, pending.scheduledAt, pending.trigger),
          );
        }
        return job;
      });
    })
    .finally(settleInvalidation);
}
function hasSchedulerTimingChanges(
  job: SchedulerJob,
  candidate: SchedulerJob,
): boolean {
  if (JSON.stringify(job.schedule) !== JSON.stringify(candidate.schedule))
    return true;
  if (job.timeZone === candidate.timeZone) return false;
  switch (candidate.schedule.kind) {
    case "daily":
    case "weekly":
    case "monthly":
      return true;
    default:
      return false;
  }
}
function hasSchedulerJobChanges(
  job: SchedulerJob,
  candidate: SchedulerJob,
): boolean {
  if (hasSchedulerTimingChanges(job, candidate)) return true;
  return ([
    "title",
    "prompt",
    "modelProfileId",
    "agentMode",
    "timeZone",
  ] as const).some((field) => job[field] !== candidate[field]);
}
function pickEditableFields(
  patch: UpdateSchedulerJobInput,
): UpdateSchedulerJobInput {
  const result: UpdateSchedulerJobInput = {};
  for (const key of [
    "title",
    "prompt",
    "modelProfileId",
    "agentMode",
    "timeZone",
    "schedule",
  ] as const) {
    if (patch[key] === undefined) continue;
    Object.assign(result, { [key]: patch[key] });
  }
  return result;
}
export function changeSchedulerJobState(
  context: SchedulerContext,
  jobId: string,
  target: SchedulerJobState,
): Promise<SchedulerJob> {
  const settleInvalidation = invalidateJob(context, jobId);
  return context
    .enqueue(async () => {
      requireRunningScheduler(context);
      return context.store.update((state) => {
        const job = requireSchedulerJob(state, jobId);
        if (job.state === "cancelled" && target !== "cancelled") {
          throw new Error("scheduler_job_cancelled");
        }
        const now = context.now();
        if (target !== "active") {
          cancelPendingRuns(state, jobId, new Date(now).toISOString());
        }
        if (job.state === target) return job;
        job.state = target;
        job.updatedAt = new Date(now).toISOString();
        job.revision += 1;
        if (target === "cancelled") job.nextRunAt = null;
        if (target !== "active") return job;
        job.nextRunAt = nextSchedulerOccurrence(
          job.schedule,
          job.timeZone,
          now,
        );
        if (!job.nextRunAt) job.state = "completed";
        return job;
      });
    })
    .finally(settleInvalidation);
}
export function requestSchedulerRunNow(
  context: SchedulerContext,
  jobId: string,
): Promise<SchedulerRun> {
  return context.enqueue(async () => {
    requireRunningScheduler(context);
    const existing = await context.store.read();
    const owner = requireSchedulerJob(existing, jobId);
    await requireExistingSession(context, owner.sessionId);
    return context.store.update((state) => {
      const job = requireSchedulerJob(state, jobId);
      if (job.state === "cancelled") throw new Error("scheduler_job_cancelled");
      if (context.deletedSessions.has(job.sessionId))
        throw new Error("scheduler_session_deleted");
      const pending = findPendingRun(state, jobId);
      if (pending) return pending;
      const run = makeSchedulerRun(
        job,
        new Date(context.now()).toISOString(),
        "manual",
      );
      state.runs.push(run);
      return run;
    });
  });
}
export function deleteSchedulerSession(
  context: SchedulerContext,
  sessionId: string,
): Promise<void> {
  // Invalidation is synchronous: no awaited preparation may dispatch after this call.
  const releaseIntent = context.deletedSessions.reserveIntent(sessionId);
  return context
    .enqueue(async () => {
      requireRunningScheduler(context);
      context.deletedSessions.add(sessionId);
      await context.store.update((state) => {
        state.jobs = state.jobs.filter((job) => job.sessionId !== sessionId);
        state.runs = state.runs.filter((run) => run.sessionId !== sessionId);
      });
    })
    .finally(releaseIntent);
}
export function matchesSchedulerFilter(
  job: SchedulerJob,
  filter: SchedulerListFilter,
): boolean {
  if (filter.sessionId !== undefined && job.sessionId !== filter.sessionId)
    return false;
  if (filter.state !== undefined && job.state !== filter.state) return false;
  if (!filter.search?.trim()) return true;
  const searchable = [job.title, job.prompt, job.sessionId, job.modelProfileId]
    .join(" ")
    .toLowerCase();
  return searchable.includes(filter.search.trim().toLowerCase());
}
async function requireExistingSession(
  context: SchedulerContext,
  sessionId: string,
): Promise<void> {
  if (context.deletedSessions.has(sessionId))
    throw new Error("scheduler_session_deleted");
  if (!(await context.executor.sessionExists(sessionId)))
    throw new Error("scheduler_session_not_found");
}
