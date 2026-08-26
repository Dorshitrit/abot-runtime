import type WebSocket from "ws";

import {
  createBoundRuntimeRequestHandler,
  createDefaultAttachmentStore,
  createDefaultEventSinkFactory,
  createDefaultModelGatewayClient,
  createDefaultRuntimeHost,
  createDefaultSessionStore,
  createDefaultToolRegistry,
} from "./default-adapters.js";
import { loadRuntimeConfig } from "./config.js";
import type {
  EventSinkFactory,
  ModelGatewayClient,
  RuntimeConfig,
  RuntimeHost,
  SessionStore,
  ToolRegistry,
} from "./ports.js";
import type { RuntimeAttachmentStore } from "./attachments/store.js";
import type {
  RequestHandlerOptions,
  RunRequestMessage,
} from "./request/contracts.js";
import {
  createModelSessionMemoryCompactor,
  type SessionMemoryCompactor,
} from "./context/session-memory/index.js";

export type RuntimeEnvironmentServices = Readonly<{
  config: RuntimeConfig;
  sessions: SessionStore;
  attachments: RuntimeAttachmentStore;
  tools: ToolRegistry;
  models: ModelGatewayClient;
  events: EventSinkFactory;
  sessionMemoryCompactor: SessionMemoryCompactor;
}>;

export type RuntimeRequestOptions = Pick<
  RequestHandlerOptions,
  "toolApprovalController" | "requestSteering"
>;

export type RuntimeRequestHandler = Readonly<{
  handle: (
    ws: WebSocket,
    message: RunRequestMessage,
    options?: RuntimeRequestOptions,
  ) => Promise<void>;
}>;

export type RuntimeApplication = Readonly<{
  services: RuntimeEnvironmentServices;
  host: RuntimeHost;
  requests: RuntimeRequestHandler;
}>;

export type RuntimeDependencies = {
  config: RuntimeConfig;
  host: RuntimeHost;
  sessions: SessionStore;
  attachments: RuntimeAttachmentStore;
  tools: ToolRegistry;
  models: ModelGatewayClient;
  events: EventSinkFactory;
  sessionMemoryCompactor: SessionMemoryCompactor;
};

export type RuntimeDependencyOverrides = Partial<
  Omit<RuntimeDependencies, "config">
>;

export type RuntimeApplicationOverrides = RuntimeDependencyOverrides;

export function createRuntimeApplication(
  config: RuntimeConfig = loadRuntimeConfig(),
  overrides: RuntimeApplicationOverrides = {},
): RuntimeApplication {
  const tools = overrides.tools ?? createDefaultToolRegistry(config);
  const services: RuntimeEnvironmentServices = Object.freeze({
    config,
    sessions: overrides.sessions ?? createDefaultSessionStore(config),
    attachments: overrides.attachments ?? createDefaultAttachmentStore(config),
    tools,
    models: overrides.models ?? createDefaultModelGatewayClient(config),
    events: overrides.events ?? createDefaultEventSinkFactory(config),
    sessionMemoryCompactor:
      overrides.sessionMemoryCompactor ?? createModelSessionMemoryCompactor(),
  });
  const requests = createRuntimeRequestHandler(services);
  const host =
    overrides.host ??
    createDefaultRuntimeHost(config, {
      runtimeId: config.runtimeId,
      agentBridgeUrl: config.agentBridgeUrl,
      agentBridgeToken: config.agentBridgeToken,
      services,
      requestHandler: requests,
      requestHandlerFactory: createRuntimeRequestHandler,
    });
  return Object.freeze({ services, host, requests });
}

export function createRuntimeRequestHandler(
  services: RuntimeEnvironmentServices,
): RuntimeRequestHandler {
  return createBoundRuntimeRequestHandler(services);
}

export function createDefaultRuntimeDependencies(
  config: RuntimeConfig = loadRuntimeConfig(),
  overrides: RuntimeDependencyOverrides = {},
): RuntimeDependencies {
  const application = createRuntimeApplication(config, overrides);
  return {
    ...application.services,
    host: application.host,
  };
}
