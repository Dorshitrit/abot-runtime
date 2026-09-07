import type { RuntimeConfig, RuntimeHostStartOptions } from "./ports.js";
import type { RuntimeEnvironmentServices } from "./composition.js";
import type { DefaultRuntimeHostBindings } from "./runtime-host.js";
import {
  createDefaultAttachmentStore,
  createDefaultEventSinkFactory,
  createDefaultLongTermMemoryService,
  createDefaultModelGatewayClient,
  createDefaultSessionStore,
} from "./default-environment-adapters.js";
import { createModelSessionMemoryCompactor } from "./context/session-memory/index.js";
import {
  rebindRuntimeEnvironmentEvents,
  recomposeRuntimeEnvironment,
} from "./runtime-environment.js";

export function resolveRuntimeHostEnvironmentServices(
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
    (mayUseLegacyDefaults ? params.defaults.toolRegistry : undefined);
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
  const mayReuseBoundLongTermMemory = mayReuseBound && models === bound?.models;
  const longTermMemory =
    params.options.longTermMemoryService ??
    (mayReuseBoundLongTermMemory ? bound?.longTermMemory : undefined) ??
    createDefaultLongTermMemoryService(runtimeConfig, models);

  const reusesBoundExecutionServices =
    mayReuseBound &&
    sessions === bound.sessions &&
    attachments === bound.attachments &&
    tools === bound.tools &&
    models === bound.models &&
    sessionMemoryCompactor === bound.sessionMemoryCompactor &&
    longTermMemory === bound.longTermMemory;
  const rebound = reusesBoundExecutionServices
    ? rebindRuntimeEnvironmentEvents(bound, events)
    : undefined;
  if (rebound) return rebound;
  return recomposeRuntimeEnvironment(runtimeConfig, bound, {
    sessions,
    attachments,
    tools,
    models,
    events,
    sessionMemoryCompactor,
    longTermMemory,
  });
}
