import type { ChatMessage } from "../../model-gateway/types.js";

/** Request-local proof minted only by a verified checkpoint projection. */
export function createVerifiedCompactionProjection() {
  const projected = new Map<ChatMessage, string>();
  return Object.freeze({
    record(message: ChatMessage) {
      projected.set(message, message.content);
    },
    clear() {
      projected.clear();
    },
    contains(messages: readonly ChatMessage[]): boolean {
      return (
        projected.size > 0 &&
        [...projected].every(
          ([message, content]) =>
            message.content === content && messages.includes(message),
        )
      );
    },
  });
}
