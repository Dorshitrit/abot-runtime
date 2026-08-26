import { resolveModelStepOutputTokenLimit } from "../../../shared/model-step-registry.js";
import {
  isAssistantToolCallMessage,
  isToolResultMessage,
  validateModelGatewayMessages,
} from "../../protocol/message-contract.js";
import {
  normalizeReasoning,
  resolveModelInvocation,
} from "../../policy/invocation-policy.js";
import {
  projectOpenAIResponsesFormat,
  resolveModelGatewayFormat,
  type OpenAISchemaProjectionDiagnostic,
} from "../../structured-output/projection.js";
import type { ModelGatewayRequest } from "../../types.js";
import type { ModelProviderInputTokenMeasurement } from "../contracts.js";
import { resolveProviderEnvelopeInputTokens } from "../envelope-budget.js";

export type OpenAIPayloadBuildOptions = Readonly<{
  onFormatProjection?: (
    diagnostics: readonly OpenAISchemaProjectionDiagnostic[],
  ) => void;
  inputTokenMeasurement?: ModelProviderInputTokenMeasurement;
}>;

function prependInstructionInput(params: {
  input: unknown;
  instructions?: string[];
}): unknown {
  const instructions = (params.instructions ?? [])
    .map((line) => line.trim())
    .filter(Boolean);
  if (instructions.length === 0) {
    return params.input;
  }

  const systemMessage = {
    role: "system",
    content: instructions.join("\n"),
  };
  if (Array.isArray(params.input)) {
    return [systemMessage, ...params.input];
  }

  const userContent = typeof params.input === "string" ? params.input : "";
  return [systemMessage, { role: "user", content: userContent }];
}

function resolveUnprojectedInput(requestBody: ModelGatewayRequest): unknown {
  const hasMessages =
    Array.isArray(requestBody.messages) && requestBody.messages.length > 0;
  if (hasMessages) {
    return requestBody.messages;
  }
  if (typeof requestBody.prompt === "string") {
    return requestBody.prompt;
  }
  return typeof requestBody.text === "string" ? requestBody.text : "";
}

function projectOpenAIInputItems(input: unknown): unknown {
  if (!Array.isArray(input)) {
    return input;
  }
  return input.flatMap((item) => {
    if (isAssistantToolCallMessage(item)) {
      return item.toolCalls.map((call) => ({
        type: "function_call",
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments,
      }));
    }
    if (isToolResultMessage(item)) {
      return [
        {
          type: "function_call_output",
          call_id: item.toolCallId,
          output: item.content,
        },
      ];
    }
    return [item];
  });
}

function resolveInputWithProviderInstructions(
  requestBody: ModelGatewayRequest,
  providerInstructions: readonly string[],
): unknown {
  const invocation = resolveModelInvocation(requestBody);
  return prependInstructionInput({
    input: projectOpenAIInputItems(resolveUnprojectedInput(requestBody)),
    instructions: [...(invocation.instructions ?? []), ...providerInstructions],
  });
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function buildOpenAIResponsesPayload(
  requestBody: ModelGatewayRequest,
  payloadOptions: OpenAIPayloadBuildOptions = {},
): Record<string, unknown> {
  validateModelGatewayMessages(requestBody.messages);
  const invocation = resolveModelInvocation(requestBody);
  const generation = invocation.profile.generation;
  const temperature = readFiniteNumber(generation.temperature);
  const topP = readFiniteNumber(generation.topP);
  const reasoningEffort =
    normalizeReasoning(requestBody.reasoningOverride) ??
    generation.reasoningEffort ??
    invocation.think;
  const formatProjection = projectOpenAIResponsesFormat(
    resolveModelGatewayFormat(requestBody.format, invocation.format),
  );
  if (formatProjection.diagnostics.length > 0) {
    payloadOptions.onFormatProjection?.(formatProjection.diagnostics);
  }

  const canUseSamplingControls =
    !invocation.profile.supportsThinking ||
    reasoningEffort === undefined ||
    reasoningEffort === "none";
  const shouldSendReasoning =
    invocation.profile.supportsThinking &&
    reasoningEffort !== undefined &&
    reasoningEffort !== "none";

  const payload: Record<string, unknown> = {
    model: invocation.model,
    input: resolveInputWithProviderInstructions(
      requestBody,
      formatProjection.instructions,
    ),
    stream: true,
  };
  if (canUseSamplingControls && temperature !== undefined) {
    payload.temperature = temperature;
  }
  if (canUseSamplingControls && topP !== undefined) {
    payload.top_p = topP;
  }
  if (shouldSendReasoning) {
    payload.reasoning = { effort: reasoningEffort };
  }
  if (formatProjection.format) {
    payload.text = { format: formatProjection.format };
  }

  const outputTokenLimit = resolveModelStepOutputTokenLimit(
    requestBody.modelStep,
  );
  if (outputTokenLimit === undefined) {
    return payload;
  }
  const { inputTokens } = resolveProviderEnvelopeInputTokens({
    payload,
    tokenEstimation: invocation.profile.context.tokenEstimation,
    ...(payloadOptions.inputTokenMeasurement
      ? { measurement: payloadOptions.inputTokenMeasurement }
      : {}),
  });
  payload.max_output_tokens = Math.max(
    1,
    Math.min(
      outputTokenLimit,
      invocation.profile.contextWindowTokens - inputTokens,
    ),
  );
  return payload;
}

export function buildOpenAIInputTokenCountPayload(
  requestBody: ModelGatewayRequest,
): Record<string, unknown> {
  const payload = { ...buildOpenAIResponsesPayload(requestBody) };
  delete payload.stream;
  delete payload.temperature;
  delete payload.top_p;
  delete payload.max_output_tokens;
  return payload;
}
