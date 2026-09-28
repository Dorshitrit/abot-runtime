import type { RuntimeConfig, ModelGatewayClient, SessionStore } from "../ports.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LearningBackgroundContext, LearningBackgroundDependencies } from "../passive-learning/background-dependencies.js";
import { createRuntimePassiveLearningModel } from "../passive-learning/model.js";
import { CoWorkerResourceBudget } from "../passive-learning/resources/budget.js";
import { DEFAULT_CO_WORKER_RESOURCE_LIMITS } from "../passive-learning/resources/contracts.js";
import { createCoWorkerResourceGateway } from "../passive-learning/resources/gateway.js";
import { createRuntimeProactiveModel } from "../passive-learning/proactive/model.js";
import { CoWorkerProactiveAgent } from "../passive-learning/proactive/agent.js";
import { isWithinAnalysisWindow } from "../passive-learning/analysis-schedule.js";
import { ScheduledLearningReassessment } from "../passive-learning/scheduled-reassessment.js";

/** The environment shares one budget; foreground chat keeps its original clients. */
export function createCoWorkerResourceDependencies(options: {
  config: RuntimeConfig; models: ModelGatewayClient; memory: LongTermMemoryService;
  directory: string; ownerId: string; context: LearningBackgroundContext;
  sessions?: SessionStore;
}): LearningBackgroundDependencies {
  const { context } = options;
  const budget = new CoWorkerResourceBudget({ directory: options.directory, limits: () => {
    const preferences = context.preferences();
    return { ...(preferences.resourceLimits ?? DEFAULT_CO_WORKER_RESOURCE_LIMITS), maxConcurrentCalls: preferences.maxConcurrentBatches ?? 1 };
  } });
  const original = createRuntimePassiveLearningModel(options);
  const processingGateway = createCoWorkerResourceGateway({
    gateway: options.models, budget, activity: "processing", assertActivityAllowed: context.assertProcessingAllowed,
    supportsParallel: () => original.supportsParallelBatches?.(context.preferences().modelProfileId ?? "") ?? false,
  });
  async function assertMemoryAvailable(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); context.assertProcessingAllowed();
    const status = await options.memory.status();
    signal.throwIfAborted(); context.assertProcessingAllowed();
    if (!status.enabled || !status.available) throw new Error("learning_memory_unavailable");
  }
  const gateway: ModelGatewayClient = {
    ...processingGateway,
    async invoke(input) { await assertMemoryAvailable(input.abortSignal); return processingGateway.invoke(input); },
    async invokeRaw(input) { await assertMemoryAvailable(input.abortSignal); return processingGateway.invokeRaw(input); },
    ...(processingGateway.embed ? { embed: async (input: Parameters<NonNullable<ModelGatewayClient["embed"]>>[0]) => {
      await assertMemoryAvailable(input.abortSignal); return processingGateway.embed!(input);
    } } : {}),
  };
  const beforeEmbedding = async ({ signal, characters }: { signal: AbortSignal; characters: number }) => {
    await assertMemoryAvailable(signal);
    return budget.reserve({ kind: "embedding", activity: "processing", signal, embeddingCharacters: characters,
      supportsParallel: false, assertActivityAllowed: context.assertProcessingAllowed });
  };
  const learning = options.memory.learning;
  const memory: LongTermMemoryService = {
    ...options.memory,
    ...(learning ? { learning: {
      ...learning,
      prepare: (input) => learning.prepare({ ...input, beforeEmbedding }),
      apply: (input) => learning.apply({ ...input, beforeEmbedding }),
    } } : {}),
  };
  const proactiveGateway = createCoWorkerResourceGateway({
    gateway: options.models, budget, activity: "proactive",
    assertActivityAllowed: () => {
      if (!context.isStarted() || context.isInteractiveBusy() || !context.preferences().proactiveEnabled) throw new Error("proactive_disabled");
      if (!isWithinAnalysisWindow(Date.now(), context.preferences().proactiveWindow)) throw new Error("proactive_outside_window");
    },
    supportsParallel: () => original.supportsParallelBatches?.(context.preferences().proactiveModelProfileId ?? context.preferences().modelProfileId ?? "") ?? false,
  });
  const proactive = learning && options.sessions ? new CoWorkerProactiveAgent({ directory: options.directory,
    context, memory: learning, sessions: options.sessions, budget,
    model: createRuntimeProactiveModel({ config: options.config, models: proactiveGateway }) }) : undefined;
  const model = createRuntimePassiveLearningModel({ ...options, models: gateway });
  const reassessment = memory.learning ? new ScheduledLearningReassessment({ directory: options.directory,
    environmentId: options.ownerId, context, memory: memory.learning, model,
    resourceUsage: () => budget.status(), changed: () => { proactive?.knowledgeChanged(); context.changed(); } }) : undefined;
  return { model, memory,
    ...(proactive ? { proactive } : {}),
    ...(reassessment ? { reassessment } : {}),
    resourceUsage: () => budget.status() };
}
