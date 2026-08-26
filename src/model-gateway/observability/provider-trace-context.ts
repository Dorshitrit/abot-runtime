import { randomUUID } from "node:crypto";

import type { ModelGatewayRequest, ResolvedModelInvocation } from "../types.js";
import type { ModelIoTraceEvent } from "./trace-store.js";

export type ProviderTraceContext = Pick<
  ModelIoTraceEvent,
  | "invocationId"
  | "requestId"
  | "endpoint"
  | "modelStep"
  | "profileId"
  | "providerId"
  | "provider"
  | "model"
>;

export function createProviderTraceContext(params: {
  endpoint: "chat" | "raw";
  requestBody: ModelGatewayRequest;
  invocation: ResolvedModelInvocation;
}): ProviderTraceContext {
  return {
    invocationId: randomUUID(),
    requestId:
      typeof params.requestBody.debugRequestId === "string"
        ? params.requestBody.debugRequestId
        : "",
    endpoint: params.endpoint,
    modelStep:
      typeof params.requestBody.modelStep === "string"
        ? params.requestBody.modelStep
        : "",
    profileId: params.invocation.profile.id,
    providerId: params.invocation.profile.providerId,
    provider: params.invocation.profile.provider,
    model: params.invocation.model,
  };
}

export function serializeProviderError(error: unknown): {
  name: string;
  message: string;
} {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}
