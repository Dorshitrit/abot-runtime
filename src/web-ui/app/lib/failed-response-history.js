import { isUserInteractionMessage } from "./user-interaction-event.js";
import { isStoppedRequest } from "./request-stop-state.js";
import { failureResponseText, isTransportFailureText } from "./failure-presentation.js";

function failedTerminal(request) {
  const events = (request.events || []).map((entry) => entry.payload || entry);
  const recorded = events.findLast((event) => event.type === "failed" || event.name === "request.failed");
  return { ...recorded, ...request.finalState,
    details: request.finalState?.details || recorded?.details };
}

function canPresentFailedResponse(message, requestId) {
  if (message.requestId !== requestId) return false;
  if (message.role !== "assistant") return false;
  if (isUserInteractionMessage(message)) return false;
  return message.kind !== "tool_approval_request";
}

/** Update display copies only; preserve saved answers and cancellation restoration. */
export function presentFailedResponseHistory(messages, requests) {
  for (const request of requests) {
    if (request.status !== "failed" || isStoppedRequest(request)) continue;
    const terminal = failedTerminal(request);
    const persisted = terminal.details?.stoppedResponse;
    for (const message of messages) {
      if (!canPresentFailedResponse(message, request.requestId)) continue;
      if (typeof persisted === "string" && persisted.trim()) {
        message.text = failureResponseText(terminal);
        continue;
      }
      if (isTransportFailureText(message.text)) {
        message.text = failureResponseText({ error: message.text });
        continue;
      }
      if (!message.text?.trim()) message.text = failureResponseText(terminal);
    }
  }
}
