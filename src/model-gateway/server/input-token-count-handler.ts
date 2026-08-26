import { traceDebug } from "../../runtime/observability/debug-logger.js";
import { resolveModelInvocation } from "../policy/invocation-policy.js";
import type { ModelGatewayRequest } from "../types.js";
import type {
  GatewayResponse,
  ModelGatewayHandlerOptions,
  ModelGatewayInvocationContext,
} from "./contracts.js";
import { respondToGatewayHandlerError } from "./errors.js";
import { sendJson, sendText } from "./http-response.js";
import type { InputTokenMeasurementStore } from "./input-token-measurements.js";
import {
  applyConfiguredModelPolicy,
  validateImageInvocationSupport,
  validateMessageInteractionRequest,
} from "./invocation-validation.js";
import { createAbortBoundProviderFetch } from "./provider-fetch.js";
import { resolveProviderAdapters } from "./provider-registry.js";

export function createInputTokenCountHandler(
  options: ModelGatewayHandlerOptions = {},
  inputTokenMeasurements?: InputTokenMeasurementStore,
) {
  const { fetchImpl = fetch, modelPolicy } = options;
  const providerAdapters = resolveProviderAdapters(options);

  return async function inputTokenCountHandler(
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
      if (!providerAdapter.countInputTokens) {
        return sendText(
          response,
          501,
          "model_provider_input_token_count_unsupported",
        );
      }

      const result = await providerAdapter.countInputTokens({
        endpoint: "chat",
        requestBody: effectiveRequestBody,
        invocation,
        fetchImpl: createAbortBoundProviderFetch({
          endpoint: "input_tokens",
          requestBody: effectiveRequestBody,
          invocation,
          fetchImpl,
          abortSignal,
        }),
      });
      if (abortSignal.aborted) {
        return;
      }
      if (result.kind === "error") {
        return sendText(response, result.statusCode, result.message);
      }

      inputTokenMeasurements?.record(
        { requestBody: effectiveRequestBody, invocation },
        result,
      );

      traceDebug("model-gateway.server", "model.input_tokens.counted", {
        requestId:
          typeof effectiveRequestBody.debugRequestId === "string"
            ? effectiveRequestBody.debugRequestId
            : "",
        modelStep: effectiveRequestBody.modelStep,
        profileId: invocation.profile.id,
        provider: invocation.profile.provider,
        model: invocation.model,
        inputTokens: result.inputTokens,
      });
      return sendJson(response, 200, {
        inputTokens: result.inputTokens,
        profileId: invocation.profile.id,
        provider: invocation.profile.provider,
        model: invocation.model,
        contextWindowTokens: invocation.profile.contextWindowTokens,
        source: "provider_input_token_count",
      });
    } catch (error) {
      respondToGatewayHandlerError({
        error,
        response,
        abortSignal,
        includeContextWindowErrors: false,
      });
    }
  };
}
