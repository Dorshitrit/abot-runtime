import { validateModelGatewayMessages } from "../../protocol/message-contract.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import {
  projectOllamaFormat,
  resolveModelGatewayFormat,
  type OllamaFormatProjection,
  type OllamaSchemaProjectionDiagnostic,
} from "../../structured-output/projection.js";
import type {
  ModelGatewayFormat,
  ModelGatewayRequest,
  ResolvedModelInvocation,
} from "../../types.js";
import {
  buildOllamaOptions,
  deriveOllamaNumPredict,
  resolveOllamaKeepAlive,
} from "./generation-options.js";
import {
  prependInstructionMessages,
  resolveOllamaRawUserContent,
  toOllamaMessage,
} from "./message-projection.js";
import { resolveOllamaChatThinking, resolveOllamaRawThinking } from "./structured-repair.js";
import type { ResolvedModelParameters } from "../../../shared/model-parameters.js";
import { resolveOllamaComputedParameters } from "./computed-parameters.js";

export { readOptionalPositiveIntEnv } from "./generation-options.js";

export type OllamaPayloadBuildOptions = Readonly<{
  onParameterResolution?: (parameters: ResolvedModelParameters) => void;
  onFormatProjection?: (
    diagnostics: readonly OllamaSchemaProjectionDiagnostic[],
  ) => void;
}>;

export function resolveFormat(
  requestBody: ModelGatewayRequest,
  fallbackFormat?: ModelGatewayFormat,
): ModelGatewayFormat | undefined {
  return resolveFormatProjection(requestBody, fallbackFormat).format;
}

export function resolveFormatProjection(
  requestBody: ModelGatewayRequest,
  fallbackFormat?: ModelGatewayFormat,
): OllamaFormatProjection {
  return projectOllamaFormat(
    resolveModelGatewayFormat(requestBody.format, fallbackFormat),
  );
}

function applyFormatProjection(params: {
  payload: Record<string, unknown>;
  projection: OllamaFormatProjection;
  payloadOptions: OllamaPayloadBuildOptions;
}): void {
  if (params.projection.diagnostics.length > 0) {
    params.payloadOptions.onFormatProjection?.(params.projection.diagnostics);
  }
  if (params.projection.format !== undefined) {
    params.payload.format = params.projection.format;
  }
}

function applyGenerationOptions(params: {
  payload: Record<string, unknown>;
  invocation: ResolvedModelInvocation;
  requestBody: ModelGatewayRequest;
  payloadOptions: OllamaPayloadBuildOptions;
}): void {
  const derivedNumPredict = deriveOllamaNumPredict({ payload: params.payload, invocation: params.invocation });
  const parameters = resolveOllamaComputedParameters(params.requestBody, params.invocation, derivedNumPredict);
  const effort = parameters?.fields.reasoning_effort;
  // A late output allowance can invalidate an already projected thinking dependency.
  if (effort?.omitted && effort.warnings.length > 0) delete params.payload.think;
  if (parameters) params.payloadOptions.onParameterResolution?.(parameters);
  params.payload.options = buildOllamaOptions({
    baseOptions: params.invocation.profile.options,
    generation: params.invocation.profile.generation,
    contextWindowTokens: params.invocation.profile.contextWindowTokens,
    derivedNumPredict,
    parameters,
  });
}

export function buildOllamaPayload(
  requestBody: ModelGatewayRequest,
  payloadOptions: OllamaPayloadBuildOptions = {},
): Record<string, unknown> {
  validateModelGatewayMessages(requestBody.messages);
  const invocation = resolveModelInvocation(requestBody);
  const baseMessages =
    Array.isArray(requestBody.messages) && requestBody.messages.length > 0
      ? requestBody.messages.map(toOllamaMessage)
      : [{ role: "user", content: requestBody.text || "" }];
  const messages = prependInstructionMessages({
    messages: baseMessages,
    instructions: invocation.instructions,
  });
  const effectiveFormat = resolveModelGatewayFormat(
    requestBody.format,
    invocation.format,
  );
  const formatProjection = projectOllamaFormat(effectiveFormat);
  const payload: Record<string, unknown> = {
    model: invocation.model,
    messages,
    stream: true,
    keep_alive: resolveOllamaKeepAlive(invocation),
  };
  applyFormatProjection({
    payload,
    projection: formatProjection,
    payloadOptions,
  });

  const thinking = resolveOllamaChatThinking({
    requestedThinking: invocation.think,
    structuredOutputRepair: requestBody.structuredOutputRepair,
    projectedFormat: formatProjection.format,
    canDisableThinking: invocation.parameters?.canDisableThinking ?? (invocation.parameters?.controls.reasoning_effort ? false : undefined),
  });
  if (thinking !== undefined) {
    payload.think = thinking;
  }
  applyGenerationOptions({
    payload,
    invocation,
    requestBody,
    payloadOptions,
  });
  return payload;
}

export function buildOllamaRawPayload(
  requestBody: ModelGatewayRequest,
  payloadOptions: OllamaPayloadBuildOptions = {},
): Record<string, unknown> {
  const invocation = resolveModelInvocation(requestBody);
  const messages = prependInstructionMessages({
    messages: [
      { role: "user", content: resolveOllamaRawUserContent(requestBody) },
    ],
    instructions: invocation.instructions,
  });
  const effectiveFormat = resolveModelGatewayFormat(
    requestBody.format,
    invocation.format,
  );
  const formatProjection = projectOllamaFormat(effectiveFormat);
  const payload: Record<string, unknown> = {
    model: invocation.model,
    messages,
    stream: true,
    ...(resolveOllamaRawThinking(invocation) !== undefined ? { think: resolveOllamaRawThinking(invocation) } : {}),
    keep_alive: resolveOllamaKeepAlive(invocation),
  };
  applyFormatProjection({
    payload,
    projection: formatProjection,
    payloadOptions,
  });
  applyGenerationOptions({
    payload,
    invocation,
    requestBody,
    payloadOptions,
  });
  return payload;
}
