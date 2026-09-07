import { handleRunRequest } from "./handler.js";
import type { RequestHandlerOptions } from "./contracts.js";
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
    sessionMemoryCompactor: services.sessionMemoryCompactor,
    longTermMemory: services.longTermMemory,
  };
  return Object.freeze({
    handle(ws, message, requestOptions = {}) {
      const invoke = () =>
        handleRunRequest(ws, message, {
          ...environmentOptions,
          ...requestOptions,
        });
      if (services.requestAdmission) {
        return services.requestAdmission.run(
          typeof message.sessionId === "string" ? message.sessionId : "",
          invoke,
        );
      }
      return invoke();
    },
  });
}
