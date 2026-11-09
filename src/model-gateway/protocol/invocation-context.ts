import type { ChatMessage } from "../types.js";
import { isStrictTextChatMessage } from "./message-contract.js";

const invocationContext = new WeakSet<ChatMessage>();

/** A producer binds its own immutable message instance. Copies and JSON carry no authority. */
export function markInvocationContextMessage<T extends ChatMessage>(message: T): T {
  if (message.role === "system" && !message.attachments?.length && isStrictTextChatMessage(message)) {
    Object.freeze(message);
    invocationContext.add(message);
  }
  return message;
}

export function isInvocationContextMessage(message: ChatMessage): boolean {
  return invocationContext.has(message) && !message.attachments?.length;
}
