import type {
  ChatAssistantToolCallMessage,
  ChatMessage,
  ChatTextMessage,
  ChatToolResultMessage,
  ModelGatewayAttachment,
  ModelGatewayToolCall,
} from "../types.js";

const MODEL_GATEWAY_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const TEXT_MESSAGE_KEYS = new Set(["role", "content", "attachments"]);
const TOOL_CALL_MESSAGE_KEYS = new Set(["role", "content", "toolCalls"]);
const TOOL_CALL_KEYS = new Set(["callId", "name", "arguments"]);
const TOOL_RESULT_MESSAGE_KEYS = new Set([
  "role",
  "content",
  "toolCallId",
  "toolName",
]);
const ATTACHMENT_KEYS = new Set([
  "id",
  "kind",
  "mimeType",
  "storageRef",
  "name",
  "size",
  "data",
]);

export class ModelGatewayMessageValidationError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ModelGatewayMessageValidationError";
  }
}

function fail(code: string): never {
  throw new ModelGatewayMessageValidationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isJsonObjectString(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed);
  } catch {
    return false;
  }
}

function isStrictAttachment(value: unknown): value is ModelGatewayAttachment {
  if (!isRecord(value) || !hasOnlyKeys(value, ATTACHMENT_KEYS)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    value.kind === "image" &&
    typeof value.mimeType === "string" &&
    value.mimeType.trim().length > 0 &&
    typeof value.storageRef === "string" &&
    value.storageRef.trim().length > 0 &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.size === undefined ||
      (typeof value.size === "number" &&
        Number.isFinite(value.size) &&
        value.size >= 0)) &&
    (value.data === undefined || typeof value.data === "string")
  );
}

export function isModelGatewayToolCall(
  value: unknown,
): value is ModelGatewayToolCall {
  if (!isRecord(value) || !hasOnlyKeys(value, TOOL_CALL_KEYS)) {
    return false;
  }
  return (
    typeof value.callId === "string" &&
    value.callId.trim().length > 0 &&
    typeof value.name === "string" &&
    MODEL_GATEWAY_TOOL_NAME_PATTERN.test(value.name) &&
    typeof value.arguments === "string" &&
    isJsonObjectString(value.arguments)
  );
}

export function isAssistantToolCallMessage(
  value: unknown,
): value is ChatAssistantToolCallMessage {
  if (!isRecord(value) || !hasOnlyKeys(value, TOOL_CALL_MESSAGE_KEYS)) {
    return false;
  }
  return (
    value.role === "assistant" &&
    value.content === "" &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.length > 0 &&
    value.toolCalls.every(isModelGatewayToolCall)
  );
}

export function isToolResultMessage(
  value: unknown,
): value is ChatToolResultMessage {
  if (!isRecord(value) || !hasOnlyKeys(value, TOOL_RESULT_MESSAGE_KEYS)) {
    return false;
  }
  return (
    value.role === "tool" &&
    typeof value.content === "string" &&
    typeof value.toolCallId === "string" &&
    value.toolCallId.trim().length > 0 &&
    typeof value.toolName === "string" &&
    MODEL_GATEWAY_TOOL_NAME_PATTERN.test(value.toolName)
  );
}

export function isTextChatMessage(value: unknown): value is ChatTextMessage {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.role === "system" ||
      value.role === "user" ||
      value.role === "assistant") &&
    typeof value.content === "string" &&
    !Object.prototype.hasOwnProperty.call(value, "toolCalls")
  );
}

function isStrictTextChatMessage(value: unknown): value is ChatTextMessage {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, TEXT_MESSAGE_KEYS) ||
    !isTextChatMessage(value)
  ) {
    return false;
  }
  return (
    value.attachments === undefined ||
    (Array.isArray(value.attachments) &&
      value.attachments.every(isStrictAttachment))
  );
}

export function hasModelGatewayToolInteractionLane(value: unknown): boolean {
  const hasMarker = (message: unknown): boolean =>
    isRecord(message) &&
    (message.role === "tool" ||
      Object.prototype.hasOwnProperty.call(message, "toolCalls"));
  return Array.isArray(value) ? value.some(hasMarker) : hasMarker(value);
}

/**
 * Enforces the native tool-call continuation protocol whenever any tool-lane
 * marker is present. Text-only arrays intentionally keep their legacy,
 * permissive normalization behavior in the client and provider projectors.
 */
export function validateModelGatewayMessages(value: unknown): void {
  if (!hasModelGatewayToolInteractionLane(value)) {
    return;
  }
  if (!Array.isArray(value)) {
    fail("model_gateway_tool_interaction_invalid");
  }

  const messages = value.map((message): ChatMessage => {
    if (isAssistantToolCallMessage(message)) {
      return message;
    }
    if (isToolResultMessage(message)) {
      return message;
    }
    if (isStrictTextChatMessage(message)) {
      return message;
    }
    return fail("model_gateway_tool_interaction_invalid");
  });

  const seenCallIds = new Set<string>();
  const settledCallIds = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (isAssistantToolCallMessage(message)) {
      for (const call of message.toolCalls) {
        if (seenCallIds.has(call.callId)) {
          fail("model_gateway_tool_call_id_duplicate");
        }
        seenCallIds.add(call.callId);
      }
      for (const [resultOffset, call] of message.toolCalls.entries()) {
        const result = messages[index + resultOffset + 1];
        if (!result) {
          fail("model_gateway_tool_result_missing");
        }
        if (!isToolResultMessage(result)) {
          fail("model_gateway_tool_result_order_invalid");
        }
        if (result.toolCallId !== call.callId) {
          fail("model_gateway_tool_result_order_invalid");
        }
        if (result.toolName !== call.name) {
          fail("model_gateway_tool_result_name_mismatch");
        }
        settledCallIds.add(call.callId);
      }
      index += message.toolCalls.length;
      continue;
    }
    if (isToolResultMessage(message)) {
      if (settledCallIds.has(message.toolCallId)) {
        fail("model_gateway_tool_result_duplicate");
      }
      fail("model_gateway_tool_result_unmatched");
    }
  }
}
