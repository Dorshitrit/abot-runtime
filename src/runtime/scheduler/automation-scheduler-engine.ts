import { randomUUID } from "node:crypto";
import type {
  PreparedAutomationOccurrence,
  SchedulerAutomationJob,
  SchedulerAutomationRun,
  SchedulerAutomationStartedRun,
  SchedulerSnapshot,
} from "./contracts.js";
import {
  hasActiveAutomationRun,
  makeAutomationSchedulerRun,
  requireAutomationSchedulerJob,
} from "./automation-run-records.js";
import { requireCommittedAutomationExecution } from "./automation-job-management.js";
import { hasReachedAutomationDailyRunLimit } from "./automation-run-budget.js";
import { settleAutomationSchedulerRun } from "./automation-run-completion.js";
import { nextSchedulerOccurrence } from "./next-occurrence.js";
import {
  canBeginSchedulerRun,
  jobEpoch,
  type SchedulerContext,
} from "./service-context.js";
import {
  isAutomationSchedulerJob,
  isAutomationSchedulerRun,
} from "./scheduler-target.js";

export async function enqueueDueAutomationOccurrences(
  context: SchedulerContext,
  now: number,
): Promise<void> {
  if (!context.automationExecutor) return;
  const snapshot = await context.store.read();
  for (const candidate of snapshot.jobs) {
    if (!isDueAutomationJob(candidate, now)) continue;
    if (hasActiveAutomationRun(snapshot, candidate.target.automationId))
      continue;
    await prepareDueAutomationOccurrence(context, candidate, now);
  }
}

function isDueAutomationJob(
  job: SchedulerSnapshot["jobs"][number],
  now: number,
): job is SchedulerAutomationJob {
  if (!isAutomationSchedulerJob(job)) return false;
  if (job.state !== "active" || !job.nextRunAt) return false;
  return Date.parse(job.nextRunAt) <= now;
}

async function prepareDueAutomationOccurrence(
  context: SchedulerContext,
  job: SchedulerAutomationJob,
  now: number,
): Promise<void> {
  const executor = context.automationExecutor;
  if (!executor) throw new Error("automation_executor_unavailable");
  const epoch = jobEpoch(context, job.id);
  const candidateRunId = randomUUID();
  const prepared = await executor.prepare(job, candidateRunId, "schedule");
  if (prepared.kind === "no_input") {
    const update = context.store.updateWithAutomations;
    if (!update) throw new Error("automation_store_unavailable");
    await update((state, automations) => {
      const live = matchingDueAutomationJob(context, state, job, epoch, now);
      if (!live) return;
      prepared.commit?.(automations);
      advanceAutomationOccurrence(live, now);
    });
    return;
  }
  let claimed = false;
  try {
    if (await hasReachedAutomationDailyRunLimit(context, job, now)) {
      await context.store.update((state) => {
        const live = matchingDueAutomationJob(context, state, job, epoch, now);
        if (live) advanceAutomationOccurrence(live, now);
      });
      return;
    }
    const update = context.store.updateWithAutomations;
    if (!update) throw new Error("automation_store_unavailable");
    const committed = await update((state, automations) => {
      const live = matchingDueAutomationJob(context, state, job, epoch, now);
      if (!live) return;
      if (hasActiveAutomationRun(state, live.target.automationId)) return;
      const run = makeAutomationSchedulerRun(
        live,
        candidateRunId,
        live.nextRunAt!,
        "schedule",
        undefined,
        new Date(now).toISOString(),
      );
      prepared.commit(automations, run.id);
      const execution = requireCommittedAutomationExecution(automations, run.id);
      if (prepared.kind === "failed") {
        requireFailedOccurrenceReport(prepared, execution.reportRef);
        run.status = "failed";
        run.error = prepared.error;
        run.reportRef = execution.reportRef;
        run.finishedAt = new Date(now).toISOString();
        live.state = "paused";
        live.updatedAt = run.finishedAt;
        live.revision += 1;
      } else {
        advanceAutomationOccurrence(live, now);
      }
      state.runs.push(run);
      return true;
    });
    claimed = committed === true;
  } finally {
    if (!claimed && prepared.kind === "ready") await prepared.discard?.();
  }
}

function requireFailedOccurrenceReport(
  prepared: Extract<PreparedAutomationOccurrence, { kind: "failed" }>,
  reportRef: string | undefined,
): asserts reportRef is string {
  if (!prepared.error || !reportRef)
    throw new Error("automation_report_missing");
}

function matchingDueAutomationJob(
  context: SchedulerContext,
  state: SchedulerSnapshot,
  prepared: SchedulerAutomationJob,
  epoch: number,
  now: number,
): SchedulerAutomationJob | null {
  if (!canBeginSchedulerRun(context, prepared.id, epoch)) return null;
  const live = state.jobs.find((candidate) => candidate.id === prepared.id);
  if (!live || !isDueAutomationJob(live, now)) return null;
  if (live.revision !== prepared.revision) return null;
  if (live.nextRunAt !== prepared.nextRunAt) return null;
  return live;
}

function advanceAutomationOccurrence(
  job: SchedulerAutomationJob,
  now: number,
): void {
  job.nextRunAt = nextSchedulerOccurrence(job.schedule, job.timeZone, now);
  if (!job.nextRunAt) job.state = "completed";
}

export async function dispatchPendingAutomationRun(
  context: SchedulerContext,
  pending: SchedulerAutomationRun,
): Promise<void> {
  const executor = context.automationExecutor;
  if (!executor) throw new Error("automation_executor_unavailable");
  const epoch = jobEpoch(context, pending.jobId);
  if (!canBeginSchedulerRun(context, pending.jobId, epoch)) return;
  const release = await executor.tryReserve(pending.target.automationId);
  if (!release) return;
  let delegated = false;
  try {
    const claimed = await claimPendingAutomationRun(context, pending, epoch);
    if (!claimed) return;
    // The durable pending -> running claim is the admission boundary. Once it
    // succeeds, a later Job edit may affect future runs but not this snapshot.
    const execution = startCapturedAutomationRun(
      context,
      claimed.job,
      claimed.run,
    );
    delegated = true;
    void settleAutomationSchedulerRun(
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

async function claimPendingAutomationRun(
  context: SchedulerContext,
  pending: SchedulerAutomationRun,
  epoch: number,
): Promise<{ job: SchedulerAutomationJob; run: SchedulerAutomationRun } | null> {
  return context.store.update((state) => {
    if (!canBeginSchedulerRun(context, pending.jobId, epoch)) return null;
    const job = state.jobs.find((item) => item.id === pending.jobId);
    if (!job || !isAutomationSchedulerJob(job)) return null;
    if (job.state === "cancelled") return null;
    const run = state.runs.find((item) => item.id === pending.id);
    if (!run || !isAutomationSchedulerRun(run)) return null;
    if (run.status !== "pending") return null;
    if (job.state === "paused" && run.trigger !== "manual") return null;
    if (hasRunningAutomationRun(state, run)) return null;
    run.status = "running";
    run.startedAt = new Date(context.now()).toISOString();
    return { job, run };
  });
}

function hasRunningAutomationRun(
  state: SchedulerSnapshot,
  candidate: SchedulerAutomationRun,
): boolean {
  return state.runs.some((run) => {
    if (!isAutomationSchedulerRun(run) || run.id === candidate.id)
      return false;
    if (run.target.automationId !== candidate.target.automationId)
      return false;
    return run.status === "running" || run.status === "stopping";
  });
}

function startCapturedAutomationRun(
  context: SchedulerContext,
  job: SchedulerAutomationJob,
  run: SchedulerAutomationRun,
): SchedulerAutomationStartedRun {
  try {
    return context.automationExecutor!.start(
      {
        ...job,
        target: { ...run.target },
        title: run.title,
        timeZone: run.timeZone,
        revision: run.jobRevision,
      },
      run,
    );
  } catch (error) {
    return {
      outcome: Promise.reject(error),
      resourcesSettled: Promise.resolve(),
    };
  }
}
