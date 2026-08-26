import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { listModelProfiles } from "../policy/model-registry.js";
import type { ModelGatewayRequest } from "../types.js";
import {
  getModelGatewayStatus,
  isLoopbackRequest,
  requestModelGatewayRestart,
} from "./admin.js";
import { createChatHandler } from "./chat-handler.js";
import { configureModelGateway } from "./configuration.js";
import type {
  GatewayResponse,
  ModelGatewayHandlerOptions,
  ModelGatewayInvocationContext,
} from "./contracts.js";
import { sendJson, sendText } from "./http-response.js";
import { createInputTokenMeasurementStore } from "./input-token-measurements.js";
import { createInputTokenCountHandler } from "./input-token-count-handler.js";
import { createProviderRequestAbortScope } from "./provider-fetch.js";
import { resolveProviderAdapters } from "./provider-registry.js";
import { createRawHandler } from "./raw-handler.js";
import { readJsonBody } from "./request-body.js";

type GatewayInvocationHandler = (
  requestBody: ModelGatewayRequest,
  response: GatewayResponse,
  context?: ModelGatewayInvocationContext,
) => Promise<void>;

async function handleProviderRequest(params: {
  request: IncomingMessage;
  response: ServerResponse;
  endpoint: "chat" | "raw" | "input_tokens";
  handler: GatewayInvocationHandler;
}): Promise<void> {
  const requestBody = await readJsonBody(params.request);
  const abortScope = createProviderRequestAbortScope({
    req: params.request,
    res: params.response,
    endpoint: params.endpoint,
    requestBody,
  });
  try {
    return await params.handler(requestBody, params.response, {
      abortSignal: abortScope.signal,
    });
  } finally {
    abortScope.dispose();
  }
}

export function createModelGatewayServer(
  options: ModelGatewayHandlerOptions = {},
) {
  const modelPolicy = configureModelGateway(options);
  const handlerOptions = {
    ...options,
    modelPolicy,
    providerAdapters: resolveProviderAdapters(options),
  };
  const inputTokenMeasurements = createInputTokenMeasurementStore();
  const chatHandler = createChatHandler(handlerOptions, inputTokenMeasurements);
  const inputTokenCountHandler = createInputTokenCountHandler(
    handlerOptions,
    inputTokenMeasurements,
  );
  const rawHandler = createRawHandler(handlerOptions);

  return createServer(async (request, response) => {
    try {
      const route = `${request.method ?? ""} ${request.url ?? ""}`;
      switch (route) {
        case "GET /models":
          return sendJson(response, 200, {
            profiles: listModelProfiles(modelPolicy),
            defaultProfileId: modelPolicy.defaults?.profileId ?? "",
            preference: {
              requestField: "modelPreference",
              defaultScope: "all",
              scopes: ["main", "all"],
              protectedBy: ["modelOverride"],
            },
          });

        case "GET /admin/status":
          if (!isLoopbackRequest(request)) {
            return sendText(response, 403, "forbidden");
          }
          return sendJson(response, 200, getModelGatewayStatus());

        case "POST /chat":
          return await handleProviderRequest({
            request,
            response,
            endpoint: "chat",
            handler: chatHandler,
          });

        case "POST /input-tokens":
          return await handleProviderRequest({
            request,
            response,
            endpoint: "input_tokens",
            handler: inputTokenCountHandler,
          });

        case "POST /raw":
          return await handleProviderRequest({
            request,
            response,
            endpoint: "raw",
            handler: rawHandler,
          });

        case "POST /admin/restart":
          if (!isLoopbackRequest(request)) {
            return sendText(response, 403, "forbidden");
          }
          return sendJson(
            response,
            200,
            requestModelGatewayRestart(
              await readJsonBody(request),
              options.restartHandler,
            ),
          );

        default:
          return sendText(response, 404, "not found");
      }
    } catch (error) {
      console.error(error);
      sendText(response, 400, "invalid request");
    }
  });
}
