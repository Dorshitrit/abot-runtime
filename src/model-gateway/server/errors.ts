import { ModelInvocationResolutionError } from "../policy/invocation-policy.js";
import { EmbeddingProviderRequestError } from "../embeddings/execution.js";
import { EmbeddingProfileResolutionError } from "../embeddings/profile.js";
import {
  ModelProviderContextWindowExceededError,
  ModelProviderEnvelopeInspectionError,
} from "../model-io-trace.js";
import { ModelProviderAdapterResolutionError } from "../providers/contracts.js";
import type { GatewayResponse } from "./contracts.js";
import { sendText } from "./http-response.js";

function handleInvocationResolutionError(
  error: unknown,
  response: GatewayResponse,
): boolean {
  if (!(error instanceof ModelInvocationResolutionError)) {
    return false;
  }
  sendText(response, error.statusCode, error.message);
  return true;
}

function handleProviderAdapterResolutionError(
  error: unknown,
  response: GatewayResponse,
): boolean {
  if (!(error instanceof ModelProviderAdapterResolutionError)) {
    return false;
  }
  sendText(response, error.statusCode, error.message);
  return true;
}

function handleEmbeddingProfileResolutionError(
  error: unknown,
  response: GatewayResponse,
): boolean {
  if (!(error instanceof EmbeddingProfileResolutionError)) {
    return false;
  }
  sendText(response, error.statusCode, error.message);
  return true;
}

function handleBadRequestError(
  error: unknown,
  response: GatewayResponse,
): boolean {
  if (
    !(error instanceof Error) ||
    !("statusCode" in error) ||
    error.statusCode !== 400
  ) {
    return false;
  }
  sendText(response, 400, error.message);
  return true;
}

function handleEmbeddingProviderRequestError(
  error: unknown,
  response: GatewayResponse,
): boolean {
  if (!(error instanceof EmbeddingProviderRequestError)) {
    return false;
  }
  sendText(response, error.statusCode, error.message);
  return true;
}

function handleProviderContextWindowError(
  error: unknown,
  response: GatewayResponse,
): boolean {
  const isContextWindowError =
    error instanceof ModelProviderContextWindowExceededError ||
    error instanceof ModelProviderEnvelopeInspectionError;
  if (!isContextWindowError) {
    return false;
  }
  sendText(response, error.statusCode, error.code);
  return true;
}

export function handleKnownGatewayError(params: {
  error: unknown;
  response: GatewayResponse;
  includeContextWindowErrors: boolean;
}): boolean {
  if (handleInvocationResolutionError(params.error, params.response)) {
    return true;
  }
  if (handleProviderAdapterResolutionError(params.error, params.response)) {
    return true;
  }
  if (handleEmbeddingProfileResolutionError(params.error, params.response)) {
    return true;
  }
  if (handleEmbeddingProviderRequestError(params.error, params.response)) {
    return true;
  }
  if (handleBadRequestError(params.error, params.response)) {
    return true;
  }
  return (
    params.includeContextWindowErrors &&
    handleProviderContextWindowError(params.error, params.response)
  );
}

export function respondToGatewayHandlerError(params: {
  error: unknown;
  response: GatewayResponse;
  abortSignal: AbortSignal;
  includeContextWindowErrors: boolean;
}): void {
  if (params.abortSignal.aborted) {
    return;
  }
  if (handleKnownGatewayError(params)) {
    return;
  }
  console.error(params.error);
  sendText(params.response, 500, "server error");
}
