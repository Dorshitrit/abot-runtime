import type WebSocket from "ws";
import { join } from "node:path";

import { buildContextBuckets, buildContextWindow } from "../sessions/index.js";
import {
  createModelGatewayClient,
  embedModelGateway,
  invokeModelGateway,
  invokeRawModelGateway,
} from "../model-gateway/client.js";
import { MAX_MODEL_GATEWAY_EMBEDDING_BATCH_SIZE } from "../model-gateway/embeddings/constants.js";
import {
  createBundledPluginSkillProvider,
  createConfiguredSkillProvider,
} from "./adapters/configured-skill-provider.js";
import { createFileSessionStore } from "./adapters/file-session-store.js";
import {
  createFileAttachmentStore,
  type RuntimeAttachmentStore,
} from "./attachments/store.js";
import { createSourceWorkspaceProvider } from "./adapters/source-workspace-provider.js";
import { createRuntimeEventBus } from "./events/runtime-emitter.js";
import { configureDebugLogger } from "./observability/debug-logger.js";
import { createConfiguredToolRegistry } from "./capabilities/configured-tool-registry.js";
import {
  loadBundledRuntimePlugins,
  loadConfiguredRuntimePlugins,
  runtimePluginsToToolModules,
} from "./plugins/loader.js";
import type {
  ConversationContextProvider,
  EventSink,
  EventSinkFactory,
  ModelGatewayClient,
  RuntimeConfig,
  SessionStore,
  SkillProvider,
  ToolRegistry,
  WorkspaceProvider,
} from "./ports.js";
import { createSchedulingToolModule } from "./capabilities/scheduling/tool-module.js";
import type { SchedulerService } from "./scheduler/contracts.js";
import { createFileLongTermMemoryRepository } from "./adapters/long-term-memory/file-repository.js";
import { createInMemoryLongTermMemoryRepository } from "./adapters/long-term-memory/in-memory-repository.js";
import {
  createLongTermMemoryService,
  type LongTermMemoryEmbeddingClient,
  type LongTermMemoryService,
} from "./long-term-memory/index.js";

export function createDefaultAttachmentStore(
  config: RuntimeConfig,
): RuntimeAttachmentStore {
  return createFileAttachmentStore({
    attachmentsDir: config.paths.attachmentsDir,
  });
}

export function createDefaultSessionStore(
  config?: RuntimeConfig,
): SessionStore {
  return createFileSessionStore(
    config ? { sessionsDir: config.paths.sessionsDir } : {},
  );
}

export function createDefaultConversationContextProvider(): ConversationContextProvider {
  return {
    buildContextBuckets,
    buildContextWindow,
  };
}

export function createDefaultToolRegistry(
  config?: RuntimeConfig,
  scheduling?: { service: SchedulerService; ready: () => Promise<void> },
): ToolRegistry {
  const plugins = config
    ? loadConfiguredRuntimePlugins(config)
    : loadBundledRuntimePlugins();
  return createConfiguredToolRegistry(config, [
    ...runtimePluginsToToolModules(plugins),
    ...(config && scheduling
      ? [
          createSchedulingToolModule(
            scheduling.service,
            config,
            scheduling.ready,
          ),
        ]
      : []),
  ]);
}

export function createDefaultSkillProvider(
  config?: RuntimeConfig,
  options: {
    toolRegistry?: Pick<ToolRegistry, "listDefinitions">;
  } = {},
): SkillProvider {
  const toolRegistry =
    options.toolRegistry ??
    (config ? createDefaultToolRegistry(config) : undefined);
  const listToolDefinitions = toolRegistry?.listDefinitions;
  if (config) {
    return createConfiguredSkillProvider({ config, listToolDefinitions });
  }
  return createBundledPluginSkillProvider({ listToolDefinitions });
}

export function createDefaultWorkspaceProvider(
  config?: RuntimeConfig,
): WorkspaceProvider {
  return createSourceWorkspaceProvider(
    config ? { workspaceDir: config.paths.workspaceDir } : {},
  );
}

export function createDefaultModelGatewayClient(
  config?: RuntimeConfig,
): ModelGatewayClient {
  if (!config) {
    return {
      invoke: invokeModelGateway,
      invokeRaw: invokeRawModelGateway,
      embed: embedModelGateway,
    };
  }
  return createModelGatewayClient({
    baseUrl: config.modelGatewayUrl,
    streamInactivityTimeoutMs: config.timeouts?.streamInactivityTimeoutMs,
    ...(config.models ? { modelPolicy: config.models } : {}),
  });
}

export function createDefaultLongTermMemoryService(
  config: RuntimeConfig | undefined,
  models: ModelGatewayClient,
): LongTermMemoryService {
  const memoryConfig = config?.longTermMemory ?? {
    enabled: false,
    emitClientEvents: false,
  };
  const repository = config
    ? createFileLongTermMemoryRepository(
        join(config.paths.runtimeDir, "long-term-memory"),
      )
    : createInMemoryLongTermMemoryRepository();
  const embeddings =
    memoryConfig.enabled && config
      ? createLongTermMemoryEmbeddingClient({ config, models })
      : undefined;
  return createLongTermMemoryService({
    repository,
    enabled: memoryConfig.enabled,
    emitClientEvents: memoryConfig.emitClientEvents,
    ...(embeddings ? { embeddings } : {}),
  });
}

function createLongTermMemoryEmbeddingClient(params: {
  config: RuntimeConfig;
  models: ModelGatewayClient;
}): LongTermMemoryEmbeddingClient {
  const profileId = params.config.longTermMemory?.embeddingProfileId;
  if (!profileId) {
    throw new Error("long_term_memory_embedding_profile_required");
  }
  if (!params.models.embed) {
    throw new Error("long_term_memory_embedding_gateway_unavailable");
  }
  const embed = params.models.embed;
  return Object.freeze({
    maxBatchSize: MAX_MODEL_GATEWAY_EMBEDDING_BATCH_SIZE,
    async embed(input) {
      const result = await embed({
        profileId,
        texts: input.texts,
        modelPolicy: params.config.models,
        abortSignal: input.abortSignal,
        ...(input.debugRequestId
          ? { debugRequestId: input.debugRequestId }
          : {}),
      });
      return Object.freeze({
        modelFingerprint: result.modelFingerprint,
        dimensions: result.dimensions,
        vectors: result.vectors,
      });
    },
  });
}

export function createDefaultEventSinkFactory(
  config?: RuntimeConfig,
): EventSinkFactory {
  if (config) {
    configureDebugLogger({
      traceFile: config.paths.traceFile,
      enabled: config.logging?.enabled,
      rotation: config.logging?.rotation,
    });
  }
  return {
    create(options: {
      requestId: string;
      ws: WebSocket;
      persist?: (payload: Record<string, unknown>) => Promise<unknown>;
    }) {
      return createRuntimeEventBus(options);
    },
  };
}

export function createNoopEventSink(): EventSink {
  return {
    publish: () => {},
    event: () => {},
    runtimeState: () => {},
    token: () => {},
    legacyToken: () => {},
    thinkingDelta: () => {},
    completed: () => {},
    failed: () => {},
    drain: async () => {},
    dispose: () => {},
  };
}
