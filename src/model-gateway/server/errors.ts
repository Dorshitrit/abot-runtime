import { ModelInvocationResolutionError } from "../policy/invocation-policy.js";
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
