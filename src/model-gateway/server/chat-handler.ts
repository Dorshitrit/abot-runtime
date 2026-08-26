import { resolveModelInvocation } from "../policy/invocation-policy.js";
import type { ModelGatewayRequest } from "../types.js";
import type {
  GatewayResponse,
  ModelGatewayHandlerOptions,
  ModelGatewayInvocationContext,
} from "./contracts.js";
import { respondToGatewayHandlerError } from "./errors.js";
import { sendText } from "./http-response.js";
import type { InputTokenMeasurementStore } from "./input-token-measurements.js";
import {
  applyConfiguredModelPolicy,
  emitResolvedModelInvocation,
  validateImageInvocationSupport,
  validateMessageInteractionRequest,
} from "./invocation-validation.js";
import { createContextGuardedProviderFetch } from "./provider-fetch.js";
import { resolveProviderAdapters } from "./provider-registry.js";

export function createChatHandler(
  options: ModelGatewayHandlerOptions = {},
  inputTokenMeasurements?: InputTokenMeasurementStore,
) {
  const { fetchImpl = fetch, modelPolicy } = options;
  const providerAdapters = resolveProviderAdapters(options);

  return async function chatHandler(
    requestBody: ModelGatewayRequest,
    response: GatewayResponse,
    context: ModelGatewayInvocationContext = {},
  ): Promise<void> {
    const abortSignal = context.abortSignal ?? new AbortController().signal;
    try {
      abortSignal.throwIfAborted();
      const effectiveRequestBody = applyConfiguredModelPolicy(
        requestBody,
        modelPolicy,
      );
      const messageValidationError = validateMessageInteractionRequest({
        requestBody: effectiveRequestBody,
        endpoint: "chat",
      });
      if (messageValidationError) {
        return sendText(response, 400, messageValidationError);
      }

      const invocation = resolveModelInvocation(effectiveRequestBody);
      emitResolvedModelInvocation({
        endpoint: "chat",
        requestBody: effectiveRequestBody,
        invocation,
      });
      const providerAdapter = providerAdapters.resolve(
        invocation.profile.provider,
      );
      const imageValidationError = validateImageInvocationSupport({
        requestBody: effectiveRequestBody,
        invocation,
        providerAdapter,
        endpoint: "chat",
      });
      if (imageValidationError) {
        return sendText(response, 400, imageValidationError);
      }

      const inputTokenMeasurement = inputTokenMeasurements?.resolve({
        requestBody: effectiveRequestBody,
        invocation,
      });

      const result = await providerAdapter.invoke({
        endpoint: "chat",
        requestBody: effectiveRequestBody,
        invocation,
        ...(inputTokenMeasurement ? { inputTokenMeasurement } : {}),
        fetchImpl: createContextGuardedProviderFetch({
          endpoint: "chat",
          requestBody: effectiveRequestBody,
          invocation,
          fetchImpl,
          abortSignal,
          ...(inputTokenMeasurement ? { inputTokenMeasurement } : {}),
        }),
      });
      if (abortSignal.aborted) {
        return;
      }
      if (result.kind === "error") {
        return sendText(response, result.statusCode, result.message);
      }
      if (result.kind !== "chat") {
        throw new Error("model_provider_adapter_chat_result_invalid");
      }

      response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache");
      await result.stream({
        emit(event) {
          response.write(`${JSON.stringify(event)}\n`);
        },
      });
      response.end();
    } catch (error) {
      respondToGatewayHandlerError({
        error,
        response,
        abortSignal,
        includeContextWindowErrors: true,
      });
    }
  };
}
