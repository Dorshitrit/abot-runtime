import type {
  SchedulerJob,
  SchedulerRun,
  SchedulerRunOutcome,
} from "./contracts.js";
import { nextSchedulerOccurrence } from "./next-occurrence.js";
import {
  reconcileSchedulerCompletions,
  settleSchedulerRun,
} from "./run-completion.js";
import {
  findPendingRun,
  hasRunningSession,
  makeSchedulerRun,
} from "./run-records.js";
import {
  canBeginSchedulerRun,
  jobEpoch,
  type SchedulerContext,
} from "./service-context.js";

export async function tickScheduler(context: SchedulerContext): Promise<void> {
  if (!context.running) return;
  await reconcileSchedulerCompletions(context);
  if (!context.running) return;
  const now = context.now();
  const snapshot = await context.store.read();
  const hasDue = snapshot.jobs.some((job) => isDueJob(job, now));
  if (hasDue) await enqueueDueOccurrences(context, now);
  const pending = (await context.store.read()).runs.filter(
    (run) => run.status === "pending",
  );
  for (const run of pending) {
    if (!context.running) return;
    await dispatchPendingRun(context, run);
  }
}
function isDueJob(job: SchedulerJob, now: number): boolean {
  if (job.state !== "active") return false;
  if (!job.nextRunAt) return false;
  return Date.parse(job.nextRunAt) <= now;
}
async function enqueueDueOccurrences(
  context: SchedulerContext,
  now: number,
): Promise<void> {
  await context.store.update((state) => {
    for (const job of state.jobs) {
      if (!isDueJob(job, now)) continue;
      const pending = findPendingRun(state, job.id);
      if (!canRecordScheduledOccurrence(pending)) continue;
      if (!pending) {
        state.runs.push(makeSchedulerRun(job, job.nextRunAt!, "schedule"));
      }
      job.nextRunAt = nextSchedulerOccurrence(job.schedule, job.timeZone, now);
      if (!job.nextRunAt) job.state = "completed";
    }
  });
}
function canRecordScheduledOccurrence(
  pending: SchedulerRun | undefined,
): boolean {
  if (!pending) return true;
  // A manual run cannot consume a recurrence. Keep its due time until the
  // single pending slot can represent scheduled work instead.
  return pending.trigger === "schedule";
}
async function dispatchPendingRun(
  context: SchedulerContext,
  pending: SchedulerRun,
): Promise<void> {
  const epoch = jobEpoch(context, pending.jobId);
  const exists = await lookupPendingRunSession(context, pending);
  if (exists === undefined) return;
  if (!exists) {
    context.deletedSessions.add(pending.sessionId);
    await removeDeletedSession(context, pending.sessionId);
    return;
  }
  if (!canBeginSchedulerRun(context, pending.jobId, pending.sessionId, epoch))
    return;
  const release = context.executor.tryReserve(pending.sessionId);
  if (!release) return;
  let delegated = false;
  try {
    const claimed = await claimPendingRun(context, pending, epoch);
    if (!claimed) return;
    // Last validity guard and start invocation are in the same synchronous turn.
    if (
      !canBeginSchedulerRun(context, pending.jobId, pending.sessionId, epoch)
    ) {
      await cancelClaimedRun(context, pending.id);
      return;
    }
    const execution = startCapturedRun(context, claimed.job, claimed.run);
    delegated = true;
    void settleSchedulerRun(
      context,
      claimed.run,
      context.generation,
      execution,
      release,
    );
  } finally {
    if (!delegated) release();
  }
}
async function lookupPendingRunSession(
  context: SchedulerContext,
  pending: SchedulerRun,
): Promise<boolean | undefined> {
  const generation = context.generation;
  try {
    return await context.executor.sessionExists(pending.sessionId);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(`scheduler_session_lookup_failed: ${detail}`, {
      cause,
    });
    // Settle after mutations already queued during lookup. A no-op edit changes
    // the preparation epoch but must not cause this same failed run to retry.
    // Cancellation or a replacement snapshot still wins by exact run identity.
    void context
      .enqueue(async () => {
        if (!context.running) return;
        if (context.generation !== generation) return;
        await context.store.update((state) => {
          const run = state.runs.find(
            (candidate) => candidate.id === pending.id,
          );
          if (!run || run.status !== "pending") return;
          run.status = "failed";
          run.finishedAt = new Date(context.now()).toISOString();
          run.error = error.message;
        });
      })
      .catch(context.onError);
    context.onError(error);
    return undefined;
  }
}
async function claimPendingRun(
  context: SchedulerContext,
  pending: SchedulerRun,
  epoch: number,
): Promise<{ job: SchedulerJob; run: SchedulerRun } | null> {
  return context.store.update((state) => {
    if (!canBeginSchedulerRun(context, pending.jobId, pending.sessionId, epoch))
      return null;
    const job = state.jobs.find((item) => item.id === pending.jobId);
    if (!job) return null;
    if (job.state === "cancelled") return null;
    const run = state.runs.find((item) => item.id === pending.id);
    if (!run || run.status !== "pending") return null;
    if (job.state === "paused" && run.trigger !== "manual") return null;
    if (hasRunningSession(state, run.sessionId)) return null;
    run.status = "running";
    run.startedAt = new Date(context.now()).toISOString();
    return { job, run };
  });
}
function startCapturedRun(
  context: SchedulerContext,
  job: SchedulerJob,
  run: SchedulerRun,
): Promise<SchedulerRunOutcome> {
  try {
    // The immutable run text owns this invocation even after a later Job edit.
    return context.executor.start(
      {
        ...job,
        prompt: run.prompt,
        title: run.title,
        modelProfileId: run.modelProfileId,
        agentMode: run.agentMode,
        timeZone: run.timeZone,
        revision: run.jobRevision,
      },
      run,
    );
  } catch (error) {
    return Promise.reject(error);
  }
}
async function cancelClaimedRun(
  context: SchedulerContext,
  runId: string,
): Promise<void> {
  await context.store.update((state) => {
    const run = state.runs.find((candidate) => candidate.id === runId);
    if (!run) return;
    run.status = "cancelled";
    run.finishedAt = new Date(context.now()).toISOString();
    delete run.startedAt;
  });
}
async function removeDeletedSession(
  context: SchedulerContext,
  sessionId: string,
): Promise<void> {
  await context.store.update((state) => {
    state.jobs = state.jobs.filter((job) => job.sessionId !== sessionId);
    state.runs = state.runs.filter((run) => run.sessionId !== sessionId);
  });
}
