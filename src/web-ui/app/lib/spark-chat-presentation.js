import { isSparkConversationMessage } from "./spark-message-visibility.js";

const ROUTINE_STATUS = new Set([
  "ABot response completed.", "ABot is working.",
  "Sending an update to the active request.", "Update accepted. ABot is working.",
  "Queueing the next message.",
]);

export function sparkMessageStatus(text) {
  const value = String(text || "");
  if (value === "ABot request failed.") return "SPARK couldn’t reply. See the message above for details.";
  return ROUTINE_STATUS.has(value) ? "" : value;
}

export function sparkWorkingStatus() {
  return null;
}

export function sparkConversationMessages(messages) {
  return messages.filter(isSparkConversationMessage);
}
