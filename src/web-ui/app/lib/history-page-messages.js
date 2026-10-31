import { orderRequestInteractionMessages } from "./request-interaction-messages.js";
import { isUserInteractionMessage } from "./user-interaction-event.js";
import { isApprovalPresentation, mergeConversationMessage, sameConversationMessage } from "./request-lifecycle-view.js";

function isRequestResponse(message) {
  if (isUserInteractionMessage(message)) return false;
  if (message.role !== "assistant") return false;
  if (!message.requestId) return false;
  return !isApprovalPresentation(message);
}

function indexConversationMessages(messages) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const byRequest = new Map();
  for (const message of messages) {
    if (!isRequestResponse(message)) continue;
    const candidates = byRequest.get(message.requestId) || [];
    candidates.push(message);
    byRequest.set(message.requestId, candidates);
  }
  return (incoming) => {
    if (!incoming) return undefined;
    const exact = byId.get(incoming.id);
    if (exact) return exact;
    return byRequest.get(incoming.requestId)?.find((message) => sameConversationMessage(message, incoming));
  };
}

/** Keep the contiguous loaded history before rows received from the live stream. */
export function mergeHistoryPage(state, incoming, direction, windowEnd) {
  const current = state.messages;
  const findCurrent = indexConversationMessages(current);
  const replaced = new Set();
  const page = incoming.map((message) => {
    const existing = findCurrent(message);
    if (!existing) return message;
    replaced.add(existing);
    return mergeConversationMessage(existing, message);
  });
  const retained = (messages) => messages.filter((message) => !replaced.has(message));
  if (direction === "older") {
    state.messages = [...page, ...retained(current)];
  } else {
    const end = current.indexOf(findCurrent(windowEnd));
    const split = end < 0 ? current.length : end + 1;
    state.messages = [...retained(current.slice(0, split)), ...page, ...retained(current.slice(split))];
  }
  state.messages = orderRequestInteractionMessages(state.messages);
  for (const message of state.messages) {
    if (!isRequestResponse(message)) continue;
    state.requestMessages?.set(message.requestId, message.id);
  }
}
