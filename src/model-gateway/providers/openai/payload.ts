import { openAIImageContents, projectOpenAIImageMessage } from "./image-content.js";
import {
  isAssistantToolCallMessage,
  isToolResultMessage,
  validateModelGatewayMessages,
} from "../../protocol/message-contract.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import {
  projectOpenAIResponsesFormat,
  resolveModelGatewayFormat,
  type OpenAISchemaProjectionDiagnostic,
} from "../../structured-output/projection.js";
import { projectOpenAIFunctionOutput } from "./function-output.js";
import type { ModelGatewayRequest } from "../../types.js";
import { markOpenAIPromptCacheItem, normalizeOpenAIPromptCacheItem, resolveOpenAIPromptCacheBoundary } from "./prompt-cache.js";

export type OpenAIPayloadBuildOptions = Readonly<{
  onFormatProjection?: (
    diagnostics: readonly OpenAISchemaProjectionDiagnostic[],
  ) => void;
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

function projectOpenAIInputItem(item: unknown): unknown[] {
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
        output: item.attachments?.length
          ? [{ type: "input_text", text: item.content }, ...openAIImageContents(item.attachments)]
          : item.content,
      },
    ];
  }
  return [projectOpenAIImageMessage(item)];
}

function projectOpenAIInputItems(input: unknown, boundaryIndex?: number) {
  let cacheBreakpointApplied = false;
  if (!Array.isArray(input)) return { input, cacheBreakpointApplied };
  const projected = input.flatMap((item, index) => {
    const items = projectOpenAIInputItem(item);
    if (!isPromptCacheBoundaryItem(index, boundaryIndex, items)) return items;
    const marked = markOpenAIPromptCacheItem(items[0]);
    if (!marked) return items;
    cacheBreakpointApplied = true;
    return [marked];
  });
  return {
    input: cacheBreakpointApplied ? projected.map(normalizeOpenAIPromptCacheItem) : projected,
    cacheBreakpointApplied,
  };
}

function isPromptCacheBoundaryItem(index: number, boundaryIndex: number | undefined, items: readonly unknown[]): boolean {
  if (boundaryIndex === undefined) return false;
  if (index !== boundaryIndex - 1) return false;
  return items.length === 1;
}

function resolveInputWithProviderInstructions(
  requestBody: ModelGatewayRequest,
  providerInstructions: readonly string[],
  boundaryIndex?: number,
) {
  const invocation = resolveModelInvocation(requestBody);
  const projected = projectOpenAIInputItems(resolveUnprojectedInput(requestBody), boundaryIndex);
  return {
    input: prependInstructionInput({
      input: projected.input,
      instructions: [...(invocation.instructions ?? []), ...providerInstructions],
    }),
    cacheBreakpointApplied: projected.cacheBreakpointApplied,
  };
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
  const reasoningEffort = invocation.think;
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
  const shouldProjectOpenAIReasoning =
    invocation.profile.supportsThinking &&
    reasoningEffort !== undefined;

  const projectedInput = resolveInputWithProviderInstructions(
    requestBody,
    formatProjection.instructions,
    resolveOpenAIPromptCacheBoundary(requestBody, invocation.profile),
  );
  const payload: Record<string, unknown> = {
    model: invocation.model,
    input: projectedInput.input,
    ...(projectedInput.cacheBreakpointApplied ? { prompt_cache_options: { mode: "implicit" } } : {}),
    stream: true,
  };
  if (canUseSamplingControls && temperature !== undefined) {
    payload.temperature = temperature;
  }
  if (canUseSamplingControls && topP !== undefined) {
    payload.top_p = topP;
  }
  if (shouldProjectOpenAIReasoning) {
    payload.reasoning = { effort: reasoningEffort };
  }
  const functionOutput = projectOpenAIFunctionOutput(requestBody.modelStep, formatProjection.format);
  if (functionOutput) {
    Object.assign(payload, functionOutput);
    return payload;
  }
  if (formatProjection.format) {
    payload.text = { format: formatProjection.format };
  }

  return payload;
}

export function buildOpenAIInputTokenCountPayload(
  requestBody: ModelGatewayRequest,
): Record<string, unknown> {
  const payload = { ...buildOpenAIResponsesPayload(requestBody) };
  delete payload.stream;
  delete payload.temperature;
  delete payload.top_p;
  delete payload.prompt_cache_options;
  return payload;
}
