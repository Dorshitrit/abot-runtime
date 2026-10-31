import { resolveModelInvocation } from "../policy/invocation-policy.js";
import type { ModelGatewayRequest } from "../types.js";
import type {
  GatewayResponse,
  ModelGatewayHandlerOptions,
  ModelGatewayInvocationContext,
} from "./contracts.js";
import { respondToGatewayHandlerError } from "./errors.js";
import { writeChatStreamResponse } from "./chat-stream-response.js";
import { sendText } from "./http-response.js";
import { sendProviderError } from "./provider-error-response.js";
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
        abortSignal,
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
        return sendProviderError(response, result, effectiveRequestBody);
      }
      if (result.kind !== "chat") {
        throw new Error("model_provider_adapter_chat_result_invalid");
      }

      await writeChatStreamResponse({
        invocation: result,
        response,
        abortSignal,
      });
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
