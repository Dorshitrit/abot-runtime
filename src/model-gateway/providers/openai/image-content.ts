import type { ModelGatewayAttachment } from "../../types.js";

/** Responses supports text/image content in messages and function outputs. */
export function openAIImageContents(attachments: readonly ModelGatewayAttachment[] | undefined) {
  return (attachments ?? []).map((attachment) => {
    if (attachment.kind !== "image" || !attachment.data)
      throw new Error("model_gateway_image_data_unavailable");
    return {
      type: "input_image" as const,
      image_url: `data:${attachment.mimeType};base64,${attachment.data}`,
      detail: "auto" as const,
    };
  });
}

export function projectOpenAIImageMessage(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const message = value as { role?: unknown; content?: unknown; attachments?: ModelGatewayAttachment[] };
  if (!message.attachments?.length) return value;
  if (typeof message.role !== "string" || typeof message.content !== "string")
    throw new Error("model_gateway_image_message_invalid");
  return {
    role: message.role,
    content: [
      { type: "input_text", text: message.content },
      ...openAIImageContents(message.attachments),
    ],
  };
}
