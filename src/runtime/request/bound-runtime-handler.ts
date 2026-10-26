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
      const releaseLearning = services.passiveLearning?.beginInteractive();
      const invoke = () =>
        handleRunRequest(ws, message, {
          ...environmentOptions,
          ...requestOptions,
        });
      try {
        if (services.requestAdmission) {
          return await services.requestAdmission.run(
            typeof message.sessionId === "string" ? message.sessionId : "",
            invoke,
            Boolean(requestOptions.approvalExecution?.resume),
          );
        }
        return await invoke();
      } finally {
        releaseLearning?.();
      }
    },
  });
}
