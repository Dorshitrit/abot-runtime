import { join } from "node:path";
import type WebSocket from "ws";
import type { RuntimeConfig, SessionStore } from "../ports.js";
import type {
  RuntimeRequestHandler,
  RuntimeRequestOptions,
} from "../composition.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";
import type {
  SchedulerJob,
  SchedulerRun,
  SchedulerRunOutcome,
} from "../scheduler/contracts.js";
import type { SessionRequestAdmission } from "../request/session-admission.js";
import { withScheduledExecution } from "../request/scheduled-execution.js";
import { resolveModelSelection } from "../model/model-selection.js";
import {
  failedScheduledRequestOutcome,
  isScheduledTerminalEvent,
  resolveScheduledRequestOutcome,
  type ScheduledRequestEvent,
  type ScheduledRequestSettlement,
} from "./scheduled-request-outcome.js";

export function createRuntimeScheduler(options: {
  config: RuntimeConfig;
  sessions: SessionStore;
  admission: SessionRequestAdmission;
  isDeleted(sessionId: string): boolean;
  handle: RuntimeRequestHandler["handle"];
  requestOptions?: (run: SchedulerRun) => RuntimeRequestOptions;
}) {
  const listeners = new Set<(event: ScheduledRequestEvent) => void>();
  let startup: Promise<void> | undefined;
  let stopped = false;
  let generation = 0;

  function canPublishRunEvents(runGeneration: number): boolean {
    if (stopped) return false;
    return runGeneration === generation;
  }

  function publish(
    event: ScheduledRequestEvent,
    sessionId: string,
    runGeneration: number,
  ): void {
    if (!canPublishRunEvents(runGeneration)) return;
    const isDeletedSession = options.isDeleted(sessionId);
    const isTerminalEvent = isScheduledTerminalEvent(event);
    if (isDeletedSession && !isTerminalEvent) return;
    const outbound = isDeletedSession
      ? { ...event, sessionDeleted: true }
      : event;
    for (const listener of [...listeners]) {
      if (!canPublishRunEvents(runGeneration)) return;
      try {
        listener(outbound);
      } catch {
        /* A view cannot alter execution settlement. */
      }
    }
  }

  async function execute(
    job: SchedulerJob,
    run: SchedulerRun,
  ): Promise<SchedulerRunOutcome> {
    const runGeneration = generation;
    const publishForRun = (event: ScheduledRequestEvent) => {
      publish(
        {
          ...event,
          requestId: run.requestId,
          sessionId: job.sessionId,
          environment: job.environmentId,
        },
        job.sessionId,
        runGeneration,
      );
    };
    const finish = (
      settlement: ScheduledRequestSettlement,
    ): SchedulerRunOutcome => {
      publishForRun(settlement.event);
      return settlement.outcome;
    };
    if (options.isDeleted(job.sessionId))
      return finish(failedScheduledRequestOutcome("session_deleted"));
    const selection = resolveModelSelection({
      agentMode: job.agentMode,
      modelPreference: { profileId: job.modelProfileId, scope: "all" },
      modelPolicy: options.config.models,
    });
    if (selection.execution.primaryProfileId !== job.modelProfileId) {
      return finish(
        failedScheduledRequestOutcome("scheduled_model_unavailable"),
      );
    }
    let terminal: ScheduledRequestEvent | undefined;
    let acceptingEvents = true;
    const ws = {
      send(data: string) {
        if (!acceptingEvents) return;
        const event = JSON.parse(data) as ScheduledRequestEvent;
        if (event.requestId !== run.requestId) return;
        if (isScheduledTerminalEvent(event)) {
          terminal = event;
          return;
        }
        publishForRun(event);
      },
    } as WebSocket;
    const message = {
      type: "run_request",
      requestId: run.requestId,
      sessionId: job.sessionId,
      text: run.prompt,
      agentMode: job.agentMode,
      modelPreference: { profileId: job.modelProfileId, scope: "all" as const },
      toolPermissionMode: "full_access",
    };
    try {
      await options.handle(
        ws,
        message,
        withScheduledExecution(options.requestOptions?.(run), run),
      );
    } catch (error) {
      terminal = failedScheduledRequestOutcome(error).event;
    } finally {
      acceptingEvents = false;
    }
    return finish(
      await resolveScheduledRequestOutcome(terminal, options.sessions, run),
    );
  }

  const scheduler = createSchedulerService({
    environmentId: options.config.runtimeId,
    store: createFileSchedulerStore(
      join(options.config.paths.runtimeDir, "scheduler"),
    ),
    executor: {
      tryReserve: (sessionId) => options.admission.tryReserve(sessionId),
      sessionExists: async (sessionId) => {
        if (options.isDeleted(sessionId)) return false;
        return (await options.sessions.getSessionById(sessionId)) !== null;
      },
      start: execute,
    },
  });
  function start(): Promise<void> {
    stopped = false;
    startup ??= scheduler.start();
    return startup;
  }

  return {
    scheduler,
    start,
    ensureStarted(): Promise<void> {
      if (stopped) return Promise.reject(new Error("scheduler_stopped"));
      return start();
    },
    stop(): Promise<void> {
      stopped = true;
      generation += 1;
      startup = undefined;
      listeners.clear();
      return scheduler.stop();
    },
    subscribe(listener: (event: ScheduledRequestEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
