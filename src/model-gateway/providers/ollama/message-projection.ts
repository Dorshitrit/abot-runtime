import {
  isAssistantToolCallMessage,
  isToolResultMessage,
} from "../../protocol/message-contract.js";
import type { ModelGatewayRequest } from "../../types.js";

type OllamaTextMessageWithAttachments = Readonly<{
  role: string;
  content: string;
  attachments: readonly unknown[];
}>;

function parseOllamaToolArguments(
  exactArguments: string,
  callId: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(exactArguments) as unknown;
  } catch {
    throw new Error(`model_gateway_tool_arguments_invalid:${callId}`);
  }
  const isObjectArguments =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  if (!isObjectArguments) {
    throw new Error(`model_gateway_tool_arguments_invalid:${callId}`);
  }
  return parsed as Record<string, unknown>;
}

function readImageData(attachment: unknown): string | undefined {
  const isRecord =
    attachment !== null &&
    typeof attachment === "object" &&
    !Array.isArray(attachment);
  if (!isRecord) {
    return undefined;
  }
  const item = attachment as { kind?: unknown; data?: unknown };
  return item.kind === "image" && typeof item.data === "string"
    ? item.data
    : undefined;
}

function readTextMessageWithAttachments(
  message: unknown,
): OllamaTextMessageWithAttachments | undefined {
  const isMessageRecord =
    message !== null && typeof message === "object" && !Array.isArray(message);
  if (!isMessageRecord) {
    return undefined;
  }

  const record = message as Record<string, unknown>;
  const hasProjectableAttachments =
    typeof record.role === "string" &&
    typeof record.content === "string" &&
    Array.isArray(record.attachments);
  return hasProjectableAttachments
    ? (record as OllamaTextMessageWithAttachments)
    : undefined;
}

export function toOllamaMessage(message: unknown): unknown {
  if (isAssistantToolCallMessage(message)) {
    return {
      role: "assistant",
      tool_calls: message.toolCalls.map((call, index) => ({
        type: "function",
        function: {
          index,
          name: call.name,
          arguments: parseOllamaToolArguments(call.arguments, call.callId),
        },
      })),
    };
  }
  if (isToolResultMessage(message)) {
    return {
      role: "tool",
      tool_name: message.toolName,
      content: message.content,
    };
  }

  const textMessage = readTextMessageWithAttachments(message);
  if (!textMessage) {
    return message;
  }

  const images = textMessage.attachments
    .map(readImageData)
    .filter(
      (image): image is string => image !== undefined && image.length > 0,
    );
  return {
    role: textMessage.role,
    content: textMessage.content,
    ...(images.length > 0 ? { images } : {}),
  };
}

export function prependInstructionMessages(params: {
  messages: unknown[];
  instructions?: string[];
}): unknown[] {
  const instructions = (params.instructions ?? [])
    .map((line) => line.trim())
    .filter(Boolean);
  if (instructions.length === 0) {
    return params.messages;
  }
  return [
    { role: "system", content: instructions.join("\n") },
    ...params.messages,
  ];
}

export function resolveOllamaRawUserContent(
  requestBody: ModelGatewayRequest,
): string {
  if (typeof requestBody.prompt === "string") {
    return requestBody.prompt;
  }
  return typeof requestBody.text === "string" ? requestBody.text : "";
}
