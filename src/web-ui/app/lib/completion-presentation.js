import { textOf } from "./text-format.js";

export function isBlockedCompletion(message) {
  const name = textOf(message?.eventName || message?.name || message?.rawType);
  if (message?.type !== "completed" && name !== "request.completed") return false;
  return message.disposition === "blocked";
}
