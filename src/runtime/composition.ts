import type WebSocket from "ws";

import {
  createBoundRuntimeRequestHandler,
  createDefaultRuntimeHost,
} from "./default-adapters.js";
import { createRuntimeEnvironment } from "./runtime-environment.js";
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
import type { SessionMemoryCompactor } from "./context/session-memory/index.js";
import type { LongTermMemoryService } from "./long-term-memory/contracts.js";
import type { SchedulerRun, SchedulerService } from "./scheduler/contracts.js";
import { SessionRequestAdmission } from "./request/session-admission.js";
import type { RequestSteeringAppendResult } from "./request/request-steering.js";

export type RuntimeEnvironmentServices = Readonly<{
  config: RuntimeConfig;
  sessions: SessionStore;
  attachments: RuntimeAttachmentStore;
  tools: ToolRegistry;
  models: ModelGatewayClient;
  events: EventSinkFactory;
  sessionMemoryCompactor: SessionMemoryCompactor;
  longTermMemory: LongTermMemoryService;
  scheduler?: SchedulerService;
  startScheduler?: () => Promise<void>;
  stopScheduler?: () => Promise<void>;
  requestAdmission?: SessionRequestAdmission;
}>;

export type RuntimeRequestOptions = Pick<
  RequestHandlerOptions,
  "toolApprovalController" | "requestSteering"
>;

export type RuntimeRequestHandler = Readonly<{
  steer?: (
    requestId: string,
    input: Readonly<{ steerId: string; text: string }>,
  ) => Promise<RequestSteeringAppendResult>;
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
  start: () => Promise<void>;
  stop: () => Promise<void>;
  subscribeScheduledEvents: (
    listener: (event: Record<string, unknown>) => void,
  ) => () => void;
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
  longTermMemory: LongTermMemoryService;
  scheduler?: SchedulerService;
  startScheduler?: () => Promise<void>;
  stopScheduler?: () => Promise<void>;
  requestAdmission?: SessionRequestAdmission;
};

export type RuntimeDependencyOverrides = Partial<
  Omit<
    RuntimeDependencies,
    | "config"
    | "scheduler"
    | "startScheduler"
    | "stopScheduler"
    | "requestAdmission"
  >
>;

export type RuntimeApplicationOverrides = RuntimeDependencyOverrides & {
  scheduledRequestOptions?: (run: SchedulerRun) => RuntimeRequestOptions;
};

export function createRuntimeApplication(
  config: RuntimeConfig = loadRuntimeConfig(),
  overrides: RuntimeApplicationOverrides = {},
): RuntimeApplication {
  const environment = createRuntimeEnvironment(config, overrides);
  const { services, requests } = environment;
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
  return Object.freeze({
    services,
    host,
    requests,
    start: environment.start,
    stop: environment.stop,
    subscribeScheduledEvents: environment.subscribeScheduledEvents,
  });
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
