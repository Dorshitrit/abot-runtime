import type {
  SchedulerExecutor,
  SchedulerService,
  SchedulerStore,
} from "./contracts.js";
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
import { SchedulerSessionDeletionState } from "./session-deletion-state.js";

export interface SchedulerServiceOptions {
  environmentId: string;
  store: SchedulerStore;
  executor: SchedulerExecutor;
  now?: () => number;
  tickIntervalMs?: number;
  onError?: (error: unknown) => void;
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
    store: createSchedulerWorkingStore(options.store),
    executor: options.executor,
    now: options.now ?? Date.now,
    running: false,
    generation: 0,
    jobEpochs: new Map(),
    pendingJobMutations: new Set(),
    deletedSessions: new SchedulerSessionDeletionState(),
    pendingCompletions: new Map(),
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
          await context.store.update((state) => {
            recoverSchedulerSnapshot(
              state,
              options.environmentId,
              context.now(),
            );
          });
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
        return (await context.store.read()).jobs.filter((job) =>
          matchesSchedulerFilter(job, filter),
        );
      }),
    get: (jobId) =>
      context.enqueue(async () => {
        requireRunningScheduler(context);
        return (
          (await context.store.read()).jobs.find((job) => job.id === jobId) ??
          null
        );
      }),
    update: (jobId, patch) => updateSchedulerJob(context, jobId, patch),
    pause: (jobId) => changeSchedulerJobState(context, jobId, "paused"),
    resume: (jobId) => changeSchedulerJobState(context, jobId, "active"),
    cancel: (jobId) => changeSchedulerJobState(context, jobId, "cancelled"),
    runNow: (jobId) => requestSchedulerRunNow(context, jobId),
    deleteSession: (sessionId) => deleteSchedulerSession(context, sessionId),
    listRuns: (jobId, query) =>
      context.enqueue(async () => {
        requireRunningScheduler(context);
        if (options.store.readRuns) return options.store.readRuns(jobId, query);
        const runs = (await options.store.read()).runs;
        return querySchedulerRuns(runs, jobId, query);
      }),
  };
  return service;
}
