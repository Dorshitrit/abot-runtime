import type WebSocket from "ws";

import { startAgentBridge } from "../bridge/start-agent-bridge.js";
import { buildContextBuckets, buildContextWindow } from "../sessions/index.js";
import {
  createModelGatewayClient,
  invokeModelGateway,
  invokeRawModelGateway,
} from "../model-gateway/client.js";
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
  RuntimeHost,
  RuntimeHostStartOptions,
  SessionStore,
  SkillProvider,
  ToolRegistry,
  WorkspaceProvider,
} from "./ports.js";
import { handleRunRequest } from "./request/handler.js";
import type { RequestHandlerOptions } from "./request/contracts.js";
import type {
  RuntimeEnvironmentServices,
  RuntimeRequestHandler,
} from "./composition.js";
import { createModelSessionMemoryCompactor } from "./context/session-memory/index.js";

export function createDefaultRuntimeHost(
  config?: RuntimeConfig,
  defaults: DefaultRuntimeHostBindings = {},
): RuntimeHost {
  return {
    start(options: RuntimeHostStartOptions = {}) {
      const services = resolveRuntimeHostEnvironmentServices({
        config,
        defaults,
        options,
      });
      const runtimeConfig = services?.config ?? options.runtimeConfig ?? config;
      const defaultRuntimeConfig = defaults.services?.config ?? config;
      const runtimeConfigIdentityChanged =
        runtimeConfig !== undefined && runtimeConfig !== defaultRuntimeConfig;
      const requestHandler = services
        ? resolveRuntimeHostRequestHandler(services, defaults)
        : defaults.requestHandler;
      return startAgentBridge({
        runtimeConfig,
        runtimeId:
          options.runtimeId ??
          (runtimeConfigIdentityChanged
            ? runtimeConfig.runtimeId
            : defaults.runtimeId),
        token:
          options.agentBridgeToken ??
          (runtimeConfigIdentityChanged
            ? runtimeConfig.agentBridgeToken
            : defaults.agentBridgeToken),
        url:
          options.agentBridgeUrl ??
          (runtimeConfigIdentityChanged
            ? runtimeConfig.agentBridgeUrl
            : defaults.agentBridgeUrl),
        eventSinkFactory:
          services?.events ??
          options.eventSinkFactory ??
          defaults.eventSinkFactory,
        modelGatewayClient:
          services?.models ??
          options.modelGatewayClient ??
          defaults.modelGatewayClient,
        sessionStore:
          services?.sessions ?? options.sessionStore ?? defaults.sessionStore,
        attachmentStore:
          services?.attachments ??
          options.attachmentStore ??
          defaults.attachmentStore ??
          (runtimeConfig
            ? createDefaultAttachmentStore(runtimeConfig)
            : undefined),
        toolRegistry:
          services?.tools ??
          options.toolRegistry ??
          defaults.toolRegistry ??
          createDefaultToolRegistry(runtimeConfig),
        requestHandler,
      });
    },
  };
}

function resolveRuntimeHostEnvironmentServices(
  params: Readonly<{
    config?: RuntimeConfig;
    defaults: DefaultRuntimeHostBindings;
    options: RuntimeHostStartOptions;
  }>,
): RuntimeEnvironmentServices | undefined {
  const bound = params.defaults.services;
  const runtimeConfig =
    params.options.runtimeConfig ?? bound?.config ?? params.config;
  if (!runtimeConfig) {
    return undefined;
  }

  const mayReuseBound = bound?.config === runtimeConfig;
  const mayUseLegacyDefaults = !bound && params.config === runtimeConfig;
  const sessions =
    params.options.sessionStore ??
    (mayReuseBound ? bound.sessions : undefined) ??
    (mayUseLegacyDefaults ? params.defaults.sessionStore : undefined) ??
    createDefaultSessionStore(runtimeConfig);
  const attachments =
    params.options.attachmentStore ??
    (mayReuseBound ? bound.attachments : undefined) ??
    (mayUseLegacyDefaults ? params.defaults.attachmentStore : undefined) ??
    createDefaultAttachmentStore(runtimeConfig);
  const tools =
    params.options.toolRegistry ??
    (mayReuseBound ? bound.tools : undefined) ??
    (mayUseLegacyDefaults ? params.defaults.toolRegistry : undefined) ??
    createDefaultToolRegistry(runtimeConfig);
  const models =
    params.options.modelGatewayClient ??
    (mayReuseBound ? bound.models : undefined) ??
    (mayUseLegacyDefaults ? params.defaults.modelGatewayClient : undefined) ??
    createDefaultModelGatewayClient(runtimeConfig);
  const events =
    params.options.eventSinkFactory ??
    (mayReuseBound ? bound.events : undefined) ??
    (mayUseLegacyDefaults ? params.defaults.eventSinkFactory : undefined) ??
    createDefaultEventSinkFactory(runtimeConfig);
  const sessionMemoryCompactor =
    bound?.sessionMemoryCompactor ?? createModelSessionMemoryCompactor();

  if (
    mayReuseBound &&
    sessions === bound.sessions &&
    attachments === bound.attachments &&
    tools === bound.tools &&
    models === bound.models &&
    events === bound.events &&
    sessionMemoryCompactor === bound.sessionMemoryCompactor
  ) {
    return bound;
  }
  return Object.freeze({
    config: runtimeConfig,
    sessions,
    attachments,
    tools,
    models,
    events,
    sessionMemoryCompactor,
  });
}

function resolveRuntimeHostRequestHandler(
  services: RuntimeEnvironmentServices,
  defaults: DefaultRuntimeHostBindings,
): RuntimeRequestHandler {
  if (services === defaults.services && defaults.requestHandler) {
    return defaults.requestHandler;
  }
  return (defaults.requestHandlerFactory ?? createBoundRuntimeRequestHandler)(
    services,
  );
}

export type DefaultRuntimeHostBindings = Readonly<{
  runtimeId?: string;
  agentBridgeUrl?: string;
  agentBridgeToken?: string;
  eventSinkFactory?: EventSinkFactory;
  modelGatewayClient?: ModelGatewayClient;
  sessionStore?: SessionStore;
  attachmentStore?: RuntimeAttachmentStore;
  toolRegistry?: ToolRegistry;
  services?: RuntimeEnvironmentServices;
  requestHandler?: RuntimeRequestHandler;
  requestHandlerFactory?: (
    services: RuntimeEnvironmentServices,
  ) => RuntimeRequestHandler;
}>;

export function createBoundRuntimeRequestHandler(
  services: RuntimeEnvironmentServices,
): RuntimeRequestHandler {
  const environmentOptions: RequestHandlerOptions = {
    runtimeConfig: services.config,
    eventSinkFactory: services.events,
    modelGatewayClient: services.models,
    sessionStore: services.sessions,
    attachmentStore: services.attachments,
    toolRegistry: services.tools,
    sessionMemoryCompactor: services.sessionMemoryCompactor,
  };
  return Object.freeze({
    handle(ws, message, requestOptions = {}) {
      return handleRunRequest(ws, message, {
        ...environmentOptions,
        ...requestOptions,
      });
    },
  });
}

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
): ToolRegistry {
  const plugins = config
    ? loadConfiguredRuntimePlugins(config)
    : loadBundledRuntimePlugins();
  return createConfiguredToolRegistry(
    config,
    runtimePluginsToToolModules(plugins),
  );
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
    };
  }
  return createModelGatewayClient({
    baseUrl: config.modelGatewayUrl,
    streamInactivityTimeoutMs: config.timeouts?.streamInactivityTimeoutMs,
    ...(config.models ? { modelPolicy: config.models } : {}),
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
