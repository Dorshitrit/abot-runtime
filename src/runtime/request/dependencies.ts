import {
  invokeModelGateway,
  invokeRawModelGateway,
  embedModelGateway,
} from "../../model-gateway/client.js";
import { defaultRuntimeSessionStore } from "../adapters/default-session-adapters.js";
import { createRuntimeEventBus } from "../events/runtime-emitter.js";
import type { EventSinkFactory, ModelGatewayClient } from "../ports.js";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import { createRequestModelPolicy } from "../config/runner/model-policy.js";
import type { RequestHandlerOptions } from "./contracts.js";
import { createModelSessionMemoryCompactor } from "../context/session-memory/index.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";

const defaultEventSinkFactory: EventSinkFactory = {
  create: createRuntimeEventBus,
};

const defaultModelGatewayClient: ModelGatewayClient = {
  invoke: invokeModelGateway,
  invokeRaw: invokeRawModelGateway,
  embed: embedModelGateway,
};

const defaultLongTermMemoryService = createLongTermMemoryService({
  repository: createInMemoryLongTermMemoryRepository(),
  enabled: false,
  emitClientEvents: false,
});

export function resolveRequestDependencies(options: RequestHandlerOptions) {
  return {
    eventSinkFactory: options.eventSinkFactory ?? defaultEventSinkFactory,
    modelGatewayClient: options.modelGatewayClient ?? defaultModelGatewayClient,
    sessionStore: options.sessionStore ?? defaultRuntimeSessionStore,
    attachmentStore: options.attachmentStore,
    sessionMemoryCompactor:
      options.sessionMemoryCompactor ?? createModelSessionMemoryCompactor(),
    longTermMemory: options.longTermMemory ?? defaultLongTermMemoryService,
    toolApprovalController: options.toolApprovalController,
    loadDecisionEnvironment: () => {
      const configPath = options.runtimeConfig?.requestRunner?.configPath;
      if (!configPath) {
        throw new Error(
          "runtime request runner is not configured: runtime config must declare requestRunner.configRef",
        );
      }
      const runnerConfig = loadRequestRunnerConfig({
        configPath,
      });

      return {
        runnerConfig,
        modelPolicy: createRequestModelPolicy({
          platformPolicy: options.runtimeConfig?.models,
          runnerConfig,
        }),
        modelExecutionPolicies: options.runtimeConfig?.modelExecutionPolicies,
      };
    },
  };
}
