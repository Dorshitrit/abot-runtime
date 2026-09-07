import { startAgentBridge } from "../bridge/start-agent-bridge.js";
import {
  createDefaultAttachmentStore,
  createDefaultToolRegistry,
} from "./default-environment-adapters.js";
import type {
  RuntimeConfig,
  RuntimeHost,
  RuntimeHostStartOptions,
  EventSinkFactory,
  ModelGatewayClient,
  SessionStore,
  ToolRegistry,
} from "./ports.js";
import type { RuntimeAttachmentStore } from "./attachments/store.js";
import type { LongTermMemoryService } from "./long-term-memory/index.js";
import type {
  RuntimeEnvironmentServices,
  RuntimeRequestHandler,
} from "./composition.js";
import { createBoundRuntimeRequestHandler } from "./request/bound-runtime-handler.js";
import { resolveRuntimeHostEnvironmentServices } from "./runtime-host-environment.js";
import { startRuntimeHostLifecycle } from "./runtime-host-lifecycle.js";

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
      return startRuntimeHostLifecycle(
        services,
        requestHandler,
        (readyHandler) =>
          startAgentBridge({
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
              services?.sessions ??
              options.sessionStore ??
              defaults.sessionStore,
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
            requestHandler: readyHandler,
          }),
      );
    },
  };
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
  longTermMemoryService?: LongTermMemoryService;
  services?: RuntimeEnvironmentServices;
  requestHandler?: RuntimeRequestHandler;
  requestHandlerFactory?: (
    services: RuntimeEnvironmentServices,
  ) => RuntimeRequestHandler;
}>;
