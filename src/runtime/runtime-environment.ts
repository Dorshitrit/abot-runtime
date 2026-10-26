import { startRuntimeInformationBasket } from "./adapters/information-basket-runtime.js";
import { createInformationBasketService } from "./information-basket/service.js";
import { canManageKnowledgeSkills } from "./knowledge-skills/personal-contracts.js";
import { createRuntimeKnowledgeSkillStore } from "./knowledge-skills/personal-store.js";
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
import {
  composeSessionMemoryCompactors,
  SESSION_MEMORY_COMPACTORS,
  type SessionMemoryCompactors,
} from "./context/super-compaction/history-routing.js";
import { createSessionLifecycleStore } from "./session/session-lifecycle-store.js";
import { createSparkSessionClearBoundary } from "./session/spark-session-clear.js";
import {
  bindManagedSessionAttachmentDeletion,
  deleteSessionAttachmentsIfSupported,
} from "./session/session-attachment-deletion.js";
import { SessionRequestAdmission } from "./request/session-admission.js";
import { createRuntimeScheduler } from "./adapters/scheduler-runtime.js";
import type { SchedulerAutomationExecutor } from "./scheduler/contracts.js";
import { createAutomationPersistence } from "./automations/persistence.js";
import { createAutomationResultStore } from "./automations/result-store.js";
import { createAutomationNodeTransactions } from "./automations/node-transactions.js";
import { createAutomationService, type AutomationService } from "./automations/service.js";
import { createAutomationRuntimeExecutor } from "./automations/runtime-executor.js";
import { compileAutomationGraph } from "./automations/graph-validation.js";
import { executeAutomationGraph } from "./automations/graph-executor.js";
import { createAutomationStepRunner } from "./automations/step-runner.js";
import { createAutomationAgentStepExecutor } from "./automations/agent-step-executor.js";
import { createAutomationReportService } from "./automations/run-report.js";
import { readAutomationCatalog } from "./automations/catalog.js";
import { fingerprintAutomationDependencies } from "./automations/dependency-fingerprint.js";
import { validateAutomationWorkingDirectory } from "./automations/working-directory.js";
import { createAutomationModelCapacity } from "./automations/model-capacity.js";
import { createAutomationToolLifetimes } from "./automations/tool-lifetimes.js";
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
  boundSessionMemoryCompactors?: SessionMemoryCompactors,
) {
  const sessionMemoryCompactors = composeSessionMemoryCompactors(
    overrides.sessionMemoryCompactor,
    boundSessionMemoryCompactors,
  );
  const backingSessions =
    overrides.sessions ?? createDefaultSessionStore(config);
  const attachments =
    overrides.attachments ?? createDefaultAttachmentStore(config);
  const sessionLifecycle = createSessionLifecycleStore(
    backingSessions,
    (result) =>
      deleteSessionAttachmentsIfSupported(attachments, result.sessionId),
    undefined,
    createSparkSessionClearBoundary(backingSessions, () => admission, attachments, config.paths.runtimeDir),
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
  let boundAutomationExecutor: Omit<SchedulerAutomationExecutor, "tryReserve"> | undefined;
  function requireAutomationExecutor(): Omit<SchedulerAutomationExecutor, "tryReserve"> {
    if (!boundAutomationExecutor) throw new Error("automation_executor_not_ready");
    return boundAutomationExecutor;
  }
  const scheduling = createRuntimeScheduler({
    config,
    sessions: sessionLifecycle.store,
    admission,
    isDeleted: sessionLifecycle.isDeleted,
    handle: (ws, message, options) => rawRequests.handle(ws, message, options),
    requestOptions: overrides.scheduledRequestOptions,
    automationExecutor: {
      prepare: (...args) => requireAutomationExecutor().prepare(...args),
      prepareReplay: (...args) => requireAutomationExecutor().prepareReplay!(...args),
      start: (...args) => requireAutomationExecutor().start(...args),
      stop: (...args) => requireAutomationExecutor().stop(...args),
      recover: (...args) => requireAutomationExecutor().recover(...args),
      reconcileSessions: () => requireAutomationExecutor().reconcileSessions!(),
      settle: (...args) => requireAutomationExecutor().settle(...args),
      cancelPending: (...args) => requireAutomationExecutor().cancelPending(...args),
      maintainRetention: (...args) => requireAutomationExecutor().maintainRetention!(...args),
    },
  });
  sessionLifecycle.onDeleted(async (sessionId) => {
    await scheduling.ensureStarted();
    await scheduling.scheduler.deleteSession(sessionId);
  });
  let automations: AutomationService | undefined;
  function requireAutomations(): AutomationService {
    if (!automations) throw new Error("automation_service_not_ready");
    return automations;
  }
  const usesDefaultToolRegistry = overrides.tools === undefined;
  const knowledgeSkillStore = overrides.knowledgeSkillStore ??
    (usesDefaultToolRegistry ? createRuntimeKnowledgeSkillStore(config.paths.runtimeDir) : undefined);
  const models = overrides.models ?? createDefaultModelGatewayClient(config);
  const informationBasket = overrides.informationBasket ??
    (usesDefaultToolRegistry ? createInformationBasketService({ config, models }) : undefined);
  const tools =
    overrides.tools ??
    createDefaultToolRegistry(config, {
      service: scheduling.scheduler,
      ready: scheduling.ensureStarted,
    }, {
      getService: requireAutomations,
      ready: scheduling.ensureStarted,
    }, knowledgeSkillStore, informationBasket);
  const automationPersistence = createAutomationPersistence(scheduling.store);
  const automationResults = createAutomationResultStore(config.paths.runtimeDir);
  const automationTransactions = createAutomationNodeTransactions({
    persistence: automationPersistence,
  });
  const automationModelCapacity = createAutomationModelCapacity();
  const automationToolLifetimes = createAutomationToolLifetimes();
  automations = createAutomationService({
    config,
    scheduler: scheduling.scheduler,
    persistence: automationPersistence,
    results: automationResults,
    tools,
  });
  const automationReports = createAutomationReportService({
    persistence: automationPersistence,
    results: automationResults,
  });
  boundAutomationExecutor = createAutomationRuntimeExecutor({
    config,
    sessions: backingSessions,
    persistence: automationPersistence,
    attachments,
    results: automationResults,
    toolLifetimes: automationToolLifetimes,
    async execute(_job, run, signal) {
      const state = await automationPersistence.read();
      const published = state.definitions.find((entry) =>
        entry.automationId === run.target.automationId &&
        entry.revision === run.target.definitionRevision);
      const definition = published?.definition;
      if (!definition) return {
        status: "failed", error: "automation_definition_not_found",
        reportRef: `derived:${run.id}`,
      };
      const workingDirectoryIssue = validateAutomationWorkingDirectory(definition.workingDirectory);
      if (workingDirectoryIssue) return {
        status: "failed", error: workingDirectoryIssue.code,
        reportRef: `derived:${run.id}`,
      };
      const compiled = compileAutomationGraph(definition);
      if (!compiled.ok) return {
        status: "failed", error: "automation_graph_invalid",
        reportRef: `derived:${run.id}`,
      };
      if (published.dependencyFingerprint) {
        const available = await readAutomationCatalog({
          automationId: run.target.automationId,
          environmentId: config.runtimeId,
          config, tools, persistence: automationPersistence,
        });
        if (fingerprintAutomationDependencies({
          definition, config, operations: available.operations,
        }) !== published.dependencyFingerprint) return {
          status: "failed", error: "automation_contract_changed",
          reportRef: `derived:${run.id}`,
        };
      }
      const agent = createAutomationAgentStepExecutor({
        // Agent attempts own their deletion guard; user-session tombstones are permanent.
        config, sessions: backingSessions, attachments, models, tools,
        modelCapacity: automationModelCapacity,
        toolLifetimes: automationToolLifetimes,
        persistence: automationPersistence, results: automationResults,
        transactions: automationTransactions, grants: { get: automations.getGrant },
        automationId: run.target.automationId, runId: run.id, definition,
      });
      const steps = createAutomationStepRunner({
        runId: run.id, automationId: run.target.automationId,
        definition, graph: compiled.graph, config, tools, attachments,
        persistence: automationPersistence, results: automationResults,
        transactions: automationTransactions, grants: { get: automations.getGrant },
        toolLifetimes: automationToolLifetimes,
        executeAgent: ({ step, inputs, sourceAttachments, signal: stepSignal }) => {
          if (step.node.kind !== "agent")
            throw new Error("automation_node_kind_invalid");
          return agent.execute({ node: step.node, inputs, sourceAttachments, signal: stepSignal });
        },
      });
      try {
        const outcome = await executeAutomationGraph({
          runId: run.id, automationId: run.target.automationId,
          definition, inputIds: state.executions.find((entry) => entry.id === run.id)?.inputIds ?? [],
          graph: compiled.graph, transactions: automationTransactions,
          abortSignal: signal, executeStep: steps.run,
        });
        const current = await automationTransactions.get(run.id);
        if (!current || current.nodes.some((node) =>
          node.status === "pending" || node.status === "ready" || node.status === "running"))
          throw new Error("automation_run_not_settled");
        let reportRef: string;
        try {
          const report = await automationReports.create({
            run,
            definition,
            outcome: outcome.status,
          });
          reportRef = report.record.id;
        } catch (error) {
          if (!(error instanceof Error) ||
              error.message !== "automation_artifact_budget_exhausted") throw error;
          // The durable node state can still project a compact report at capacity.
          reportRef = `derived:${run.id}`;
        }
        return {
          status: outcome.status,
          ...(outcome.errorCode ? { error: outcome.errorCode } : {}),
          reportRef,
        };
      } catch (error) {
        return {
          status: "failed", error: error instanceof Error ? error.message : "automation_run_failed",
          reportRef: `derived:${run.id}`,
        };
      }
    },
  });
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
      deliveryAdmission: admission,
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
    knowledgeSkillStore,
    informationBasket,
    ...(knowledgeSkillStore && canManageKnowledgeSkills(knowledgeSkillStore)
      ? { personalSkills: knowledgeSkillStore.personalSkills } : {}),
    models,
    events: overrides.events ?? createDefaultEventSinkFactory(config),
    sessionMemoryCompactor: sessionMemoryCompactors.legacy,
    [SESSION_MEMORY_COMPACTORS]: sessionMemoryCompactors,
    longTermMemory,
    passiveLearning,
    automations,
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
      await startRuntimeInformationBasket(informationBasket);
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
        informationBasket?.stop(),
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
  const preservesSkillStoreBinding =
    resolved.tools === undefined || resolved.tools === bound?.tools;
  const preservesBasketBinding = preservesSkillStoreBinding &&
    bound?.config === config &&
    (resolved.models === undefined || resolved.models === bound?.models);
  return createRuntimeEnvironment(config, {
    ...resolved,
    sessions,
    tools,
    informationBasket: resolved.informationBasket ??
      (preservesBasketBinding ? bound?.informationBasket : undefined),
    knowledgeSkillStore: resolved.knowledgeSkillStore ??
      (preservesSkillStoreBinding ? bound?.knowledgeSkillStore : undefined),
    scheduledRequestOptions: previous?.scheduledRequestOptions,
  }, bound?.[SESSION_MEMORY_COMPACTORS]).services;
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
