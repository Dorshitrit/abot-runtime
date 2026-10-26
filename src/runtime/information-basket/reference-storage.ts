import type { ChatMessage } from "../../model-gateway/types.js";

/**
 * Freeze the v1 evidence encoding independently of its model-facing result role.
 * These bytes are stored and fingerprinted, never replayed as chat messages.
 */
export function toBasketReferenceStorageMessage(message: ChatMessage): ChatMessage {
  if (!usesBasketResultRole(message)) return message;
  return Object.freeze({ ...message, role: "assistant" });
}

function usesBasketResultRole(message: ChatMessage): boolean {
  return message.role === "user";
}
