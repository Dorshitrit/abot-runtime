import { handleRunRequest } from "../runtime/request/handler.js";
import { handleCommandRun, validateCommandRequest } from "../runtime/commands/run.js";
import { parseRequestInput } from "../runtime/request/input.js";
import { SessionRequestAdmission } from "../runtime/request/session-admission.js";
import type { RequestHandlerOptions } from "../runtime/request/contracts.js";
import type { RuntimeRequestHandler } from "../runtime/composition.js";
import type { AgentBridgeOptions } from "./start-agent-bridge.js";

/** Standalone Bridge callers share the same admission policy as managed owners. */
export function createBoundBridgeRequestHandler(
  options: Pick<AgentBridgeOptions,
    | "runtimeConfig"
    | "eventSinkFactory"
    | "modelGatewayClient"
    | "sessionStore"
    | "attachmentStore"
    | "toolRegistry"
  >,
): RuntimeRequestHandler {
  const environmentOptions: RequestHandlerOptions = {
    runtimeConfig: options.runtimeConfig,
    eventSinkFactory: options.eventSinkFactory,
    modelGatewayClient: options.modelGatewayClient,
    sessionStore: options.sessionStore,
    attachmentStore: options.attachmentStore,
    toolRegistry: options.toolRegistry,
  };
  const admission = new SessionRequestAdmission(
    () => false,
    async (sessionId) => Boolean(
      (await options.sessionStore?.requestLifecycle?.listWaiting(sessionId))?.length,
    ),
  );
  return {
    async handle(ws, message, requestOptions = {}) {
      const command = message.command === undefined ? undefined : validateCommandRequest(message);
      return admission.run(parseRequestInput(message).sessionId, async () => {
        if (command) return handleCommandRun(ws, message, command, { ...environmentOptions, ...requestOptions });
        await requestOptions.onAccepted?.();
        return handleRunRequest(ws, message, {
          ...environmentOptions,
          ...requestOptions,
        });
      });
    },
  };
}
