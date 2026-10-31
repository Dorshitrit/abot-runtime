import { isApprovalPresentation } from "./request-lifecycle-view.js";

/** Approval controls have their own surface and are not SPARK conversation messages. */
export function isSparkConversationMessage(message) {
  return !isApprovalPresentation(message);
}

export function isSparkAssistantMessage(message) {
  if (message.role !== "assistant") return false;
  return isSparkConversationMessage(message);
}
