import { createRuntimeProjectService } from "./projects/service.js";
import { traceDebug } from "./observability/debug-logger.js";
import { createRuntimePassiveLearning } from "./adapters/passive-learning-runtime.js";
import {
  createDefaultAttachmentStore,
  createDefaultEventSinkFactory,
  createDefaultModelGatewayClient,
  createDefaultLongTermMemoryService,
  createDefaultSessionStore,
  createDefaultToolRegistry,
} from "./default-environment-adapters.js";
import { createBoundRuntimeRequestHandler } from "./request/bound-runtime-handler.js";
import { createModelSessionMemoryCompactor } from "./context/session-memory/index.js";
import { createSessionLifecycleStore } from "./session/session-lifecycle-store.js";
import {
  bindManagedSessionAttachmentDeletion,
  deleteSessionAttachmentsIfSupported,
} from "./session/session-attachment-deletion.js";
import { SessionRequestAdmission } from "./request/session-admission.js";
import { createRuntimeScheduler } from "./adapters/scheduler-runtime.js";
import type { EventSinkFactory, RuntimeConfig } from "./ports.js";
import type {
  RuntimeApplicationOverrides,
  RuntimeEnvironmentServices,
} from "./composition.js";

// Composition metadata, never request state. A rebound graph retains caller
// supplied adapters while replacing closures that belong to its old scheduler.
const environmentCompositions = new WeakMap<
  RuntimeEnvironmentServices,
  Readonly<{
    overrides: RuntimeApplicationOverrides;
    bindScheduledEvents(events: EventSinkFactory): void;
  }>
>();

export function createRuntimeEnvironment(
  config: RuntimeConfig,
  overrides: RuntimeApplicationOverrides = {},
) {
  const backingSessions =
    overrides.sessions ?? createDefaultSessionStore(config);
  const attachments =
    overrides.attachments ?? createDefaultAttachmentStore(config);
  const sessionLifecycle = createSessionLifecycleStore(
    backingSessions,
    (result) =>
      deleteSessionAttachmentsIfSupported(attachments, result.sessionId),
  );
  bindManagedSessionAttachmentDeletion(sessionLifecycle.store, attachments);
  const admission = new SessionRequestAdmission(
    sessionLifecycle.isDeleted,
    async (sessionId) =>
      Boolean(
        (await sessionLifecycle.store.requestLifecycle?.listWaiting(sessionId))
          ?.length,
      ),
  );
  const scheduling = createRuntimeScheduler({
    config,
    sessions: sessionLifecycle.store,
    admission,
    isDeleted: sessionLifecycle.isDeleted,
    handle: (ws, message, options) => rawRequests.handle(ws, message, options),
    requestOptions: overrides.scheduledRequestOptions,
  });
  sessionLifecycle.onDeleted(async (sessionId) => {
    await scheduling.ensureStarted();
    await scheduling.scheduler.deleteSession(sessionId);
  });
  const tools =
    overrides.tools ??
    createDefaultToolRegistry(config, {
      service: scheduling.scheduler,
      ready: scheduling.ensureStarted,
    });
  const models = overrides.models ?? createDefaultModelGatewayClient(config);
  const longTermMemory =
    overrides.longTermMemory ??
    createDefaultLongTermMemoryService(config, models);
  const passiveLearning =
    overrides.passiveLearning ??
    createRuntimePassiveLearning({
      config,
      models,
      memory: longTermMemory,
      sessions: sessionLifecycle.store,
    });
  sessionLifecycle.onDeleted(async (sessionId) => {
    try {
      await passiveLearning.sessionDeleted?.(sessionId);
    } catch {
      traceDebug(
        "runtime.passive_learning",
        "proposal.session_cleanup_failed",
        {
          reason: "proactive_session_cleanup_failed",
        },
      );
    }
  });
  const services: RuntimeEnvironmentServices = Object.freeze({
    config,
    sessions: sessionLifecycle.store,
    projects: createRuntimeProjectService(config, sessionLifecycle.store),
    attachments,
    tools,
    models,
    events: overrides.events ?? createDefaultEventSinkFactory(config),
    sessionMemoryCompactor:
      overrides.sessionMemoryCompactor ?? createModelSessionMemoryCompactor(),
    longTermMemory,
    passiveLearning,
    scheduler: scheduling.scheduler,
    startScheduler: scheduling.start,
    stopScheduler: scheduling.stop,
    requestAdmission: admission,
  });
  // The scheduler has already atomically reserved admission before this handler.
  let rawRequests = createBoundRuntimeRequestHandler({
    ...services,
    requestAdmission: undefined,
  });
  const requests = createBoundRuntimeRequestHandler(services);
  environmentCompositions.set(services, {
    overrides: { ...overrides, sessions: backingSessions },
    bindScheduledEvents(events) {
      // Each invocation captures one immutable handler. An event-only host
      // override affects future runs without mutating a delegating factory.
      rawRequests = createBoundRuntimeRequestHandler({
        ...services,
        events,
        requestAdmission: undefined,
      });
    },
  });
  let unsubscribeInjectedLearning: (() => void) | undefined;
  return {
    services,
    requests,
    async start() {
      await scheduling.start();
      await longTermMemory.retention?.start();
      const notifyInjectedLearning =
        overrides.passiveLearning?.notifyKnowledgeChanged;
      if (notifyInjectedLearning) {
        unsubscribeInjectedLearning ??= longTermMemory.subscribeChanges?.(
          () => {
            overrides.passiveLearning!.notifyKnowledgeChanged!();
          },
        );
      }
      try {
        await passiveLearning.start();
      } catch (error) {
        unsubscribeInjectedLearning?.();
        unsubscribeInjectedLearning = undefined;
        throw error;
      }
    },
    async stop() {
      unsubscribeInjectedLearning?.();
      unsubscribeInjectedLearning = undefined;
      await Promise.all([
        passiveLearning.stop(),
        scheduling.stop(),
        longTermMemory.retention?.stop(),
      ]);
    },
    subscribeScheduledEvents: scheduling.subscribe,
  };
}

export function recomposeRuntimeEnvironment(
  config: RuntimeConfig,
  bound: RuntimeEnvironmentServices | undefined,
  resolved: RuntimeApplicationOverrides,
): RuntimeEnvironmentServices {
  const previous = bound
    ? environmentCompositions.get(bound)?.overrides
    : undefined;
  const replacesComposedToolRegistry =
    previous !== undefined && resolved.tools === bound?.tools;
  const tools = replacesComposedToolRegistry ? previous.tools : resolved.tools;
  const sessions =
    resolved.sessions === bound?.sessions
      ? (previous?.sessions ?? resolved.sessions)
      : resolved.sessions;
  return createRuntimeEnvironment(config, {
    ...resolved,
    sessions,
    tools,
    scheduledRequestOptions: previous?.scheduledRequestOptions,
  }).services;
}

export function rebindRuntimeEnvironmentEvents(
  bound: RuntimeEnvironmentServices,
  events: EventSinkFactory,
): RuntimeEnvironmentServices | undefined {
  const composition = environmentCompositions.get(bound);
  if (!composition) return events === bound.events ? bound : undefined;
  composition.bindScheduledEvents(events);
  if (events === bound.events) return bound;
  const services = Object.freeze({ ...bound, events });
  environmentCompositions.set(services, composition);
  return services;
}
