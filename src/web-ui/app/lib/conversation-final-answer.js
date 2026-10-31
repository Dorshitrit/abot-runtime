import { isBlockedCompletion } from "./completion-presentation.js";
import { isApprovalPresentation } from "./request-lifecycle-view.js";
import { isUserInteractionMessage } from "./user-interaction-event.js";

function isRequestTerminalPresentation(event) {
  if (event.type === "completed" || event.type === "failed") return true;
  const name = event.eventName || event.name || event.rawType;
  return name === "request.completed" || name === "request.failed";
}

/** Approval waits, failures and stopped responses do not complete the work view. */
export function hasCompletedConversationAnswer(message, events = []) {
  if (message?.role !== "assistant") return false;
  if (isUserInteractionMessage(message)) return false;
  if (isApprovalPresentation(message)) return false;
  if (message.streaming) return false;
  if (typeof message.text !== "string" || !message.text.trim()) return false;
  const terminal = events.filter((event) => event.requestId === message.requestId)
    .filter(isRequestTerminalPresentation).at(-1);
  if (terminal?.type === "failed" || isBlockedCompletion(terminal)) return false;
  if ((terminal?.eventName || terminal?.name || terminal?.rawType) === "request.failed") return false;
  return true;
}
