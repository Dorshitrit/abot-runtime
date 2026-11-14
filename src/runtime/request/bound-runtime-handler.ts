import { parseRequestInput } from "./input.js";
import { handleCommandRun, validateCommandRequest } from "../commands/run.js";
import { handleRunRequest } from "./handler.js";
import type { RequestHandlerOptions } from "./contracts.js";
import { SESSION_MEMORY_COMPACTORS } from "../context/super-compaction/history-routing.js";
import { createSparkChatAccess } from "../spark-chat/service.js";
import type {
  RuntimeEnvironmentServices,
  RuntimeRequestHandler,
} from "../composition.js";

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
    knowledgeSkillStore: services.knowledgeSkillStore,
    informationBasket: services.informationBasket,
    sessionMemoryCompactor: services.sessionMemoryCompactor,
    [SESSION_MEMORY_COMPACTORS]: services[SESSION_MEMORY_COMPACTORS],
    longTermMemory: services.longTermMemory,
  };
  return Object.freeze({
    sparkChat: services.passiveLearning
      ? createSparkChatAccess({ ...services, passiveLearning: services.passiveLearning })
      : undefined,
    async handle(ws, message, requestOptions = {}) {
      const command = message.command === undefined ? undefined : validateCommandRequest(message);
      const invoke = async () => {
        if (!command) await requestOptions.onAccepted?.();
        const releaseLearning = services.passiveLearning?.beginInteractive();
        try {
          if (command) return await handleCommandRun(ws, message, command, { ...environmentOptions, ...requestOptions });
          return await handleRunRequest(ws, message, {
            ...environmentOptions,
            ...requestOptions,
          });
        } finally {
          releaseLearning?.();
        }
      };
      if (services.requestAdmission) {
        return services.requestAdmission.run(
          parseRequestInput(message).sessionId,
          invoke,
          Boolean(requestOptions.approvalExecution?.resume),
          requestOptions.sessionAdmission,
        );
      }
      return invoke();
    },
  });
}
