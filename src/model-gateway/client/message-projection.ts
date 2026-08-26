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
} from "../types.js";
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
    };
  }
  const attachments = normalizeMessageAttachments(message.attachments);
  return {
    role: message.role,
    content: message.content,
    ...(attachments ? { attachments } : {}),
  };
}

export function resolveRequestMessages(params: {
  text?: string;
  messages?: unknown;
}): ChatMessage[] {
  validateModelGatewayMessages(params.messages);
  const rawMessages = Array.isArray(params.messages) ? params.messages : [];
  const baseMessages = rawMessages.flatMap((message) => {
    if (isChatMessage(message)) {
      return [toRequestMessage(message)];
    }
    return [];
  });
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

export function buildChatGatewayRequestBody(
  params: Readonly<{
    text?: string;
    agentMode: AgentMode;
    taskType?: string;
    modelStep?: ModelStep;
    modelOverride?: string;
    reasoningOverride?: ModelReasoningLevel;
    modelPreference?: ModelPreference;
    debugRequestId?: string;
    format?: "json" | Record<string, unknown>;
  }>,
  messages: readonly ChatMessage[],
  modelPolicy: ModelGatewayPolicyConfig | undefined,
): Record<string, unknown> {
  const requestId = params.debugRequestId?.trim() ?? "";
  return {
    ...(params.text !== undefined ? { text: params.text } : {}),
    messages,
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
    ...(params.modelPreference
      ? { modelPreference: params.modelPreference }
      : {}),
    ...(modelPolicy ? { modelPolicy } : {}),
    ...(params.format !== undefined ? { format: params.format } : {}),
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
