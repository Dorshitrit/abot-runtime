import type { ModelReasoningPreference } from "../../shared/model-reasoning.js";
import type {
  AgentMode,
  ModelReasoningLevel,
  ModelStep,
} from "../../shared/types.js";
import {
  isAssistantToolCallMessage,
  isTextChatMessage,
  isToolResultMessage,
  validateModelGatewayMessages,
} from "../message-contract.js";
import type {
  ChatMessage,
  ModelGatewayAttachment,
  ModelGatewayPolicyConfig,
  ModelPreference,
  ModelStructuredOutputRepair,
} from "../types.js";
import { isInvocationContextMessage } from "../protocol/invocation-context.js";
import type { ModelMetricMessage } from "./contracts.js";

function isChatMessage(value: unknown): value is ChatMessage {
  return (
    isAssistantToolCallMessage(value) ||
    isToolResultMessage(value) ||
    isTextChatMessage(value)
  );
}

function normalizeMessageAttachments(
  value: unknown,
): ModelGatewayAttachment[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const attachments = value.filter(
    (entry): entry is ModelGatewayAttachment =>
      !!entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { kind?: unknown }).kind === "image" &&
      typeof (entry as { mimeType?: unknown }).mimeType === "string" &&
      typeof (entry as { storageRef?: unknown }).storageRef === "string",
  );
  return attachments.length > 0 ? attachments : undefined;
}

function toAttachmentMetadata(
  attachment: ModelGatewayAttachment,
): ModelGatewayAttachment {
  return {
    id: attachment.id,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    storageRef: attachment.storageRef,
    ...(attachment.name ? { name: attachment.name } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
  };
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "string" && item.trim().length > 0
    ? item.trim()
    : undefined;
}

function toMetricMessage(message: ChatMessage): ModelMetricMessage {
  if (isAssistantToolCallMessage(message)) {
    return {
      role: message.role,
      content: message.toolCalls
        .flatMap(({ callId, name, arguments: exactArguments }) => [
          callId,
          name,
          exactArguments,
        ])
        .join("\n"),
      contextMessageKind: "model_gateway_tool_calls",
      toolCallCount: message.toolCalls.length,
    };
  }
  if (isToolResultMessage(message)) {
    return {
      role: message.role,
      content: [message.toolCallId, message.toolName, message.content].join(
        "\n",
      ),
      contextMessageKind: "model_gateway_tool_result",
      toolResultCount: 1,
    };
  }
  const systemMessageKind = readStringField(message, "systemMessageKind");
  const contextMessageKind = readStringField(message, "contextMessageKind");
  const attachments = normalizeMessageAttachments(message.attachments);
  return {
    role: message.role,
    content: message.content,
    ...(systemMessageKind ? { systemMessageKind } : {}),
    ...(contextMessageKind ? { contextMessageKind } : {}),
    ...(attachments
      ? { attachments: attachments.map(toAttachmentMetadata) }
      : {}),
  };
}

export function projectModelGatewayMetricMessages(
  messages: readonly ChatMessage[],
): ModelMetricMessage[] {
  return messages.map(toMetricMessage);
}

function toRequestMessage(message: ChatMessage): ChatMessage {
  if (isAssistantToolCallMessage(message)) {
    return {
      role: "assistant",
      content: "",
      toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })),
    };
  }
  if (isToolResultMessage(message)) {
    return {
      role: "tool",
      content: message.content,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    };
  }
  const attachments = normalizeMessageAttachments(message.attachments);
  return {
    role: message.role,
    content: message.content,
    ...(attachments ? { attachments } : {}),
  };
}

type ChatGatewayMessageProjection = {
  messages: ChatMessage[];
  invocationContextMessageIndices?: number[];
};

/** Bind producer permissions to positions in this specific normalized request. */
export function projectChatGatewayMessages(params: {
  text?: string;
  messages?: unknown;
}): ChatGatewayMessageProjection {
  validateModelGatewayMessages(params.messages);
  const source = Array.isArray(params.messages) ? params.messages : [];
  const messages: ChatMessage[] = [];
  const invocationContextMessageIndices: number[] = [];
  for (const message of source) {
    if (!isChatMessage(message)) continue;
    if (isInvocationContextMessage(message)) invocationContextMessageIndices.push(messages.length);
    messages.push(toRequestMessage(message));
  }
  const promptText = typeof params.text === "string" ? params.text.trim() : "";
  if (promptText) appendPromptText(messages, promptText);
  return invocationContextMessageIndices.length ? { messages, invocationContextMessageIndices } : { messages };
}

function appendPromptText(messages: ChatMessage[], promptText: string): void {
  const last = messages.at(-1);
  if (last?.role === "user" && last.attachments?.length) {
    messages[messages.length - 1] = { ...last, content: `${last.content}\n\n${promptText}` };
    return;
  }
  messages.push({ role: "user", content: promptText });
}

export function buildChatGatewayRequestBody(
  params: Readonly<{
    structuredOutputRepair?: ModelStructuredOutputRepair;
    text?: string;
    promptCacheBoundaryBeforeMessageIndex?: number;
    agentMode: AgentMode;
    taskType?: string;
    modelStep?: ModelStep;
    modelOverride?: string;
    reasoningOverride?: ModelReasoningLevel;
    modelPreference?: ModelPreference;
  reasoningPreference?: ModelReasoningPreference;
    debugRequestId?: string;
    format?: "json" | Record<string, unknown>;
  }>,
  projection: ChatGatewayMessageProjection,
  modelPolicy: ModelGatewayPolicyConfig | undefined,
): Record<string, unknown> {
  const requestId = params.debugRequestId?.trim() ?? "";
  return {
    ...(params.text !== undefined ? { text: params.text } : {}),
    ...projection,
    ...(params.promptCacheBoundaryBeforeMessageIndex !== undefined
      ? { promptCacheBoundaryBeforeMessageIndex: params.promptCacheBoundaryBeforeMessageIndex }
      : {}),
    ...(requestId ? { debugRequestId: requestId } : {}),
    agentMode: params.agentMode,
    ...(typeof params.taskType === "string"
      ? { taskType: params.taskType }
      : {}),
    ...(typeof params.modelStep === "string"
      ? { modelStep: params.modelStep }
      : {}),
    ...(typeof params.modelOverride === "string" && params.modelOverride.trim()
      ? { modelOverride: params.modelOverride.trim() }
      : {}),
    ...(params.reasoningOverride
      ? { reasoningOverride: params.reasoningOverride }
      : {}),
    ...(params.reasoningPreference ? { reasoningPreference: params.reasoningPreference } : {}),
    ...(params.modelPreference
      ? { modelPreference: params.modelPreference }
      : {}),
    ...(modelPolicy ? { modelPolicy } : {}),
    ...(params.format !== undefined ? { format: params.format } : {}),
    ...(params.structuredOutputRepair
      ? { structuredOutputRepair: params.structuredOutputRepair }
      : {}),
  };
}

export function resolveMetricMessages(params: {
  text?: string;
  messages?: unknown;
}): ModelMetricMessage[] {
  const baseMessages = Array.isArray(params.messages)
    ? projectModelGatewayMetricMessages(params.messages.filter(isChatMessage))
    : [];
  const promptText = typeof params.text === "string" ? params.text.trim() : "";

  if (promptText.length === 0) {
    return baseMessages;
  }
  if (baseMessages.length === 0) {
    return [{ role: "user", content: promptText }];
  }
  const lastMessage = baseMessages[baseMessages.length - 1];
  if (lastMessage?.role === "user" && lastMessage.attachments?.length) {
    return [
      ...baseMessages.slice(0, -1),
      {
        ...lastMessage,
        content: `${lastMessage.content}\n\n${promptText}`,
      },
    ];
  }

  return [...baseMessages, { role: "user", content: promptText }];
}
