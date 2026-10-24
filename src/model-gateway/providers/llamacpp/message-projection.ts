import {
  hasModelGatewayToolInteractionLane, isAssistantToolCallMessage, isTextChatMessage,
  isToolResultMessage, validateModelGatewayMessages,
} from "../../protocol/message-contract.js";
import type { ModelGatewayRequest, ResolvedModelInvocation } from "../../types.js";

export function projectLlamaCppMessages(
  request: ModelGatewayRequest,
  invocation: ResolvedModelInvocation,
  endpoint: "chat" | "raw",
): Record<string, unknown>[] {
  validateModelGatewayMessages(request.messages);
  if (endpoint === "raw" && hasModelGatewayToolInteractionLane(request.messages)) {
    throw new TypeError("model_gateway_raw_tool_interaction_unsupported");
  }
  const input = Array.isArray(request.messages) && request.messages.length > 0
    ? request.messages
    : [{ role: "user", content: request.prompt ?? request.text ?? "" }];
  const messages = input.map((message): Record<string, unknown> => {
    if (message?.attachments?.length) throw new TypeError("llamacpp_image_input_unsupported");
    if (isAssistantToolCallMessage(message)) {
      return {
        role: "assistant", content: "",
        tool_calls: message.toolCalls.map((call) => ({
          id: call.callId, type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    if (isToolResultMessage(message)) {
      return { role: "tool", tool_call_id: message.toolCallId, name: message.toolName, content: message.content };
    }
    if (!isTextChatMessage(message)) throw new TypeError("llamacpp_message_invalid");
    return { role: message.role, content: message.content };
  });
  const instructions = (invocation.instructions ?? []).map((line) => line.trim()).filter(Boolean);
  return instructions.length
    ? [{ role: "system", content: instructions.join("\n") }, ...messages]
    : messages;
}
