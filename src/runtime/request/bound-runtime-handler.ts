import { parseRequestInput } from "./input.js";
import { handleRunRequest } from "./handler.js";
import type { RequestHandlerOptions } from "./contracts.js";
import { SESSION_MEMORY_COMPACTORS } from "../context/super-compaction/history-routing.js";
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
    async handle(ws, message, requestOptions = {}) {
      const invoke = async () => {
        await requestOptions.onAccepted?.();
        const releaseLearning = services.passiveLearning?.beginInteractive();
        try {
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
