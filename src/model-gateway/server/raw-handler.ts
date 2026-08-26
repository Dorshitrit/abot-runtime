import { resolveModelInvocation } from "../policy/invocation-policy.js";
import type { ModelGatewayRequest } from "../types.js";
import type {
  GatewayResponse,
  ModelGatewayHandlerOptions,
  ModelGatewayInvocationContext,
} from "./contracts.js";
import { respondToGatewayHandlerError } from "./errors.js";
import { sendJson, sendText } from "./http-response.js";
import {
  applyConfiguredModelPolicy,
  emitResolvedModelInvocation,
  validateImageInvocationSupport,
  validateMessageInteractionRequest,
} from "./invocation-validation.js";
import { createContextGuardedProviderFetch } from "./provider-fetch.js";
import { resolveProviderAdapters } from "./provider-registry.js";

export function createRawHandler(options: ModelGatewayHandlerOptions = {}) {
  const { fetchImpl = fetch, modelPolicy } = options;
  const providerAdapters = resolveProviderAdapters(options);

  return async function rawHandler(
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
        endpoint: "raw",
      });
      if (messageValidationError) {
        return sendText(response, 400, messageValidationError);
      }

      const invocation = resolveModelInvocation(effectiveRequestBody);
      emitResolvedModelInvocation({
        endpoint: "raw",
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
        endpoint: "raw",
      });
      if (imageValidationError) {
        return sendText(response, 400, imageValidationError);
      }

      const result = await providerAdapter.invoke({
        endpoint: "raw",
        requestBody: effectiveRequestBody,
        invocation,
        fetchImpl: createContextGuardedProviderFetch({
          endpoint: "raw",
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
      if (result.kind !== "raw") {
        throw new Error("model_provider_adapter_raw_result_invalid");
      }
      return sendJson(response, 200, result.body);
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
