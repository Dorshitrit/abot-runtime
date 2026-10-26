import type {
  SchedulerAutomationExecutor,
  SchedulerAutomationJob,
  SchedulerExecutor,
  SchedulerJob,
  SchedulerService,
  SchedulerSnapshot,
  SchedulerStore,
} from "./contracts.js";
import type { AutomationJournalState } from "../automations/storage-records.js";
import {
  changeAutomationSchedulerJobState,
  createAutomationSchedulerJob,
  requestAutomationSchedulerRunNow,
  updateAutomationSchedulerJob,
} from "./automation-job-management.js";
import { stopAutomationSchedulerRun } from "./automation-run-control.js";
import { requestAutomationSchedulerRerun } from "./automation-rerun.js";
import {
  changeSchedulerJobState,
  createSchedulerJob,
  deleteSchedulerSession,
  matchesSchedulerFilter,
  requestSchedulerRunNow,
  updateSchedulerJob,
} from "./job-management.js";
import { tickScheduler } from "./scheduler-engine.js";
import {
  requireRunningScheduler,
  type SchedulerContext,
} from "./service-context.js";
import { recoverSchedulerSnapshot } from "./startup-recovery.js";
import { querySchedulerRuns } from "./run-list-query.js";
import { createSchedulerWorkingStore } from "./working-store.js";
import { observeAutomationRunChanges, type AutomationRunChange } from "./automation-run-change-events.js";
import { SchedulerSessionDeletionState } from "./session-deletion-state.js";
import {
  isAutomationSchedulerJob,
  isAutomationSchedulerRun,
  isRequestSchedulerJob,
  isRequestSchedulerRun,
} from "./scheduler-target.js";

import { GuardedSchedulerJobMutations } from "./guarded-job-mutations.js";

export interface SchedulerServiceOptions {
  environmentId: string;
  store: SchedulerStore;
  executor: SchedulerExecutor;
  automationExecutor?: SchedulerAutomationExecutor;
  now?: () => number;
  tickIntervalMs?: number;
  onError?: (error: unknown) => void;
  onAutomationRunChange?: (change: AutomationRunChange) => void;
}
export function createSchedulerService(
  options: SchedulerServiceOptions,
): SchedulerService {
  let tail: Promise<unknown> = Promise.resolve();
  let releaseOwner: (() => Promise<void>) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;
  const context: SchedulerContext = {
    environmentId: options.environmentId,
    store: options.onAutomationRunChange
      ? observeAutomationRunChanges(createSchedulerWorkingStore(options.store), options.onAutomationRunChange)
      : createSchedulerWorkingStore(options.store),
    executor: options.executor,
    automationExecutor: options.automationExecutor,
    now: options.now ?? Date.now,
    running: false,
    generation: 0,
    jobEpochs: new Map(),
    pendingJobMutations: new Set(),
    guardedJobMutations: new GuardedSchedulerJobMutations(),
    deletedSessions: new SchedulerSessionDeletionState(),
    pendingCompletions: new Map(),
    pendingAutomationCompletions: new Map(),
    enqueue: <T>(operation: () => Promise<T>): Promise<T> => {
      const result = tail.then(operation);
      tail = result.catch(() => undefined);
      return result;
    },
    onError:
      options.onError ?? ((error) => console.error("Scheduler failed:", error)),
  };
  const service: SchedulerService = {
    start: () => {
      const requestedGeneration = context.generation;
      return context.enqueue(async () => {
        if (requestedGeneration !== context.generation) return;
        if (context.running) return;
        const release = await options.store.acquire();
        releaseOwner = release;
        try {
          const automationExecutor = options.automationExecutor;
          if (automationExecutor) {
            const update = context.store.updateWithAutomations;
            if (!update) throw new Error("automation_store_unavailable");
            await update((state, automations) => {
              const recovered = recoverSchedulerSnapshot(
                state,
                options.environmentId,
                context.now(),
              );
              automationExecutor.recover(
                state,
                automations,
                recovered,
              );
              requireRecoveredAutomationReports(state, automations, recovered);
            });
            await automationExecutor.reconcileSessions?.().catch(context.onError);
          } else {
            await context.store.update((state) => {
              if (state.jobs.some(isAutomationSchedulerJob))
                throw new Error("automation_executor_unavailable");
              recoverSchedulerSnapshot(state, options.environmentId, context.now());
            });
          }
          if (requestedGeneration !== context.generation) {
            await release();
            releaseOwner = undefined;
            return;
          }
          context.running = true;
          timer = setInterval(() => {
            void service.tick().catch(context.onError);
          }, options.tickIntervalMs ?? 1_000);
          timer.unref();
        } catch (error) {
          await release();
          releaseOwner = undefined;
          throw error;
        }
      });
    },
    stop: () => {
      // Stop invalidates every in-flight preparation before waiting for disk writes.
      context.generation += 1;
      context.running = false;
      context.pendingCompletions.clear();
      context.pendingAutomationCompletions.clear();
      if (timer) clearInterval(timer);
      timer = undefined;
      return context.enqueue(async () => {
        const release = releaseOwner;
        releaseOwner = undefined;
        await release?.();
      });
    },
    tick: () => {
      if (ticking) return ticking;
      const pending = context.enqueue(() => tickScheduler(context));
      ticking = pending;
      void pending
        .finally(() => {
          if (ticking === pending) ticking = undefined;
        })
        .catch(() => undefined);
      return pending;
    },
    create: (input) => createSchedulerJob(context, input),
    list: (filter = {}) =>
      context.enqueue(async () => {
        requireRunningScheduler(context);
        return (await context.store.read()).jobs
          .filter(isRequestSchedulerJob)
          .filter((job) => matchesSchedulerFilter(job, filter));
      }),
    get: (jobId) =>
      context.enqueue(async () => {
        requireRunningScheduler(context);
        return (
          (await context.store.read()).jobs.find(
            (job): job is SchedulerJob =>
              isRequestSchedulerJob(job) && job.id === jobId,
          ) ??
          null
        );
      }),
    update: (jobId, patch, guard) => updateSchedulerJob(context, jobId, patch, guard),
    pause: (jobId, guard) => changeSchedulerJobState(context, jobId, "paused", guard),
    resume: (jobId, guard) => changeSchedulerJobState(context, jobId, "active", guard),
    cancel: (jobId, guard) => changeSchedulerJobState(context, jobId, "cancelled", guard),
    runNow: (jobId, guard) => requestSchedulerRunNow(context, jobId, guard),
    deleteSession: (sessionId) => deleteSchedulerSession(context, sessionId),
    listRuns: (jobId, query) =>
      context.enqueue(async () => {
        requireRunningScheduler(context);
        const runs = options.store.readRuns
          ? await options.store.readRuns(jobId, query, "request")
          : (await options.store.read()).runs;
        return querySchedulerRuns(
          runs.filter(isRequestSchedulerRun),
          jobId,
          options.store.readRuns ? undefined : query,
        );
      }),
    createAutomationJob: (input, commitPublication) =>
      createAutomationSchedulerJob(context, input, commitPublication),
    getAutomationJob: (automationId) =>
      context.enqueue(async () => {
        requireRunningScheduler(context);
        return (
          (await context.store.read()).jobs.find(
            (job): job is SchedulerAutomationJob =>
              isAutomationSchedulerJob(job) &&
              job.target.automationId === automationId,
          ) ?? null
        );
      }),
    listAutomationJobs: () =>
      context.enqueue(async () => {
        requireRunningScheduler(context);
        return (await context.store.read()).jobs.filter(isAutomationSchedulerJob);
      }),
    updateAutomationJob: (jobId, patch, commitPublication) =>
      updateAutomationSchedulerJob(context, jobId, patch, commitPublication),
    pauseAutomationJob: (jobId) =>
      changeAutomationSchedulerJobState(context, jobId, "paused"),
    resumeAutomationJob: (jobId) =>
      changeAutomationSchedulerJobState(context, jobId, "active"),
    runNowAutomation: (jobId, runOptions) =>
      requestAutomationSchedulerRunNow(context, jobId, runOptions),
    rerunAutomationRun: (previousRunId, runOptions) =>
      requestAutomationSchedulerRerun(context, previousRunId, runOptions),
    stopAutomationRun: (runId) => stopAutomationSchedulerRun(context, runId),
    listAutomationRuns: (automationId, query) =>
      context.enqueue(async () => {
        requireRunningScheduler(context);
        const job = (await context.store.read()).jobs.find(
          (item) =>
            isAutomationSchedulerJob(item) &&
            item.target.automationId === automationId,
        );
        if (!job) return [];
        const boundedQuery = query ?? { limit: 100 };
        const runs = options.store.readRuns
          ? await options.store.readRuns(job.id, boundedQuery, "automation")
          : (await options.store.read()).runs;
        return querySchedulerRuns(
          runs.filter(isAutomationSchedulerRun),
          job.id,
          options.store.readRuns ? undefined : boundedQuery,
        );
      }),
    getAutomationRun: (runId) =>
      context.enqueue(async () => {
        requireRunningScheduler(context);
        const run = options.store.readRun
          ? await options.store.readRun(runId)
          : (await options.store.read()).runs.find((item) => item.id === runId);
        return run && isAutomationSchedulerRun(run) ? run : null;
      }),
  };
  return service;
}

function requireRecoveredAutomationReports(
  scheduler: SchedulerSnapshot,
  automations: AutomationJournalState,
  runIds: readonly string[],
): void {
  for (const runId of runIds) {
    const run = scheduler.runs.find((item) => item.id === runId);
    if (!run || !isAutomationSchedulerRun(run) || !run.reportRef)
      throw new Error("automation_report_missing");
    const execution = automations.executions.find((item) => item.id === runId);
    if (execution?.reportRef !== run.reportRef)
      throw new Error("automation_report_missing");
  }
}
