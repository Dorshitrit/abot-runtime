import { traceDebug } from "../../runtime/observability/debug-logger.js";
import {
  hasModelGatewayToolInteractionLane,
  ModelGatewayMessageValidationError,
  validateModelGatewayMessages,
} from "../protocol/message-contract.js";
import type { ModelProviderAdapter } from "../providers/contracts.js";
import type {
  ModelGatewayPolicyConfig,
  ModelGatewayRequest,
  ResolvedModelInvocation,
} from "../types.js";

type ImageAttachment = Readonly<{
  kind?: unknown;
  data?: unknown;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readImageAttachments(
  requestBody: ModelGatewayRequest,
): readonly ImageAttachment[] {
  if (!Array.isArray(requestBody.messages)) {
    return [];
  }

  const attachments: ImageAttachment[] = [];
  for (const message of requestBody.messages) {
    if (!isRecord(message) || !Array.isArray(message.attachments)) {
      continue;
    }
    for (const attachment of message.attachments) {
      if (isRecord(attachment) && attachment.kind === "image") {
        attachments.push(attachment);
      }
    }
  }
  return attachments;
}

function resolveModelPreferenceScope(
  requestBody: ModelGatewayRequest,
): "" | "main" | "all" {
  if (!requestBody.modelPreference) {
    return "";
  }
  return requestBody.modelPreference.scope === "main" ? "main" : "all";
}

export function applyConfiguredModelPolicy(
  requestBody: ModelGatewayRequest,
  modelPolicy?: ModelGatewayPolicyConfig,
): ModelGatewayRequest {
  return modelPolicy ? { ...requestBody, modelPolicy } : requestBody;
}

export function emitResolvedModelInvocation(params: {
  endpoint: "chat" | "raw";
  requestBody: ModelGatewayRequest;
  invocation: ResolvedModelInvocation;
}): void {
  const profile = params.invocation.profile;
  traceDebug("model-gateway.server", "model.invocation.resolved", {
    requestId:
      typeof params.requestBody.debugRequestId === "string"
        ? params.requestBody.debugRequestId
        : "",
    endpoint: params.endpoint,
    agentMode: params.requestBody.agentMode,
    taskType: params.requestBody.taskType,
    modelStep: params.requestBody.modelStep,
    modelPreferenceProfileId: params.requestBody.modelPreference?.profileId,
    modelPreferenceScope: resolveModelPreferenceScope(params.requestBody),
    modelPolicyDefaultProfileId:
      params.requestBody.modelPolicy?.defaults?.profileId,
    profileId: profile.id,
    profileLabel: profile.label,
    providerId: profile.providerId,
    provider: profile.provider,
    model: params.invocation.model,
    reasoning: params.invocation.think,
    supportsThinking: profile.supportsThinking,
    capabilities: profile.capabilities,
    generation: profile.generation,
    context: profile.context,
  });
}

export function validateImageInvocationSupport(params: {
  requestBody: ModelGatewayRequest;
  invocation: ResolvedModelInvocation;
  providerAdapter: ModelProviderAdapter;
  endpoint?: "chat" | "raw";
}): string | null {
  const imageAttachments = readImageAttachments(params.requestBody);
  if (imageAttachments.length === 0) {
    return null;
  }
  if (params.endpoint === "raw") {
    return "raw_image_attachments_not_supported";
  }

  const hasMissingImageData = imageAttachments.some(
    (attachment) =>
      typeof attachment.data !== "string" || attachment.data.length === 0,
  );
  if (hasMissingImageData) {
    return "image_attachment_data_required";
  }
  if (
    !params.invocation.profile.capabilities.inputModalities.includes("image")
  ) {
    return "resolved_model_does_not_support_image_input";
  }
  if (!params.providerAdapter.supportsImageInput) {
    return "resolved_provider_does_not_support_image_input";
  }
  return null;
}

export function validateMessageInteractionRequest(params: {
  requestBody: ModelGatewayRequest;
  endpoint: "chat" | "raw";
}): string | null {
  try {
    validateModelGatewayMessages(params.requestBody.messages);
  } catch (error) {
    return error instanceof ModelGatewayMessageValidationError
      ? error.message
      : "model_gateway_tool_interaction_invalid";
  }

  const rawRequestContainsToolInteraction =
    params.endpoint === "raw" &&
    hasModelGatewayToolInteractionLane(params.requestBody.messages);
  return rawRequestContainsToolInteraction
    ? "model_gateway_raw_tool_interaction_not_supported"
    : null;
}
