import { isUserInteractionMessage } from "./user-interaction-event.js";

export function isApprovalPresentation(message) {
  return message?.kind === "tool_approval_request";
}

/** Saved waits and their continuation share one visible response and timeline. */
export function projectApprovalContinuations(messages) {
  const approvalRequests = new Set(
    messages
      .filter(isApprovalPresentation)
      .map((message) => message.requestId)
      .filter(Boolean),
  );
  const responses = new Map();
  for (const message of messages) {
    const previous = responses.get(message.requestId);
    if (isUserInteractionMessage(message) && previous) previous.hasLaterInteraction = true;
    if (!isApprovalContinuation(message, approvalRequests)) continue;
    const anchor = previous && !previous.hasLaterInteraction ? previous.anchor : message;
    responses.set(message.requestId, { anchor, latest: message, hasLaterInteraction: false });
  }
  return messages.flatMap((message) => {
    if (!isApprovalContinuation(message, approvalRequests)) return [message];
    const { anchor, latest } = responses.get(message.requestId);
    if (message !== anchor) return [];
    return [{ ...latest, createdAt: anchor.createdAt }];
  });
}

function isApprovalContinuation(message, approvalRequests) {
  if (isUserInteractionMessage(message)) return false;
  if (message.role !== "assistant") return false;
  return approvalRequests.has(message.requestId);
}

export function requestLifecycles(state) {
  return (state.requestLifecycles ??= new Map());
}

export function rememberRequestLifecycle(state, lifecycle) {
  if (lifecycle?.schemaVersion !== 1 || !lifecycle.requestId) return false;
  const states = requestLifecycles(state);
  const previous = states.get(lifecycle.requestId);
  if (
    previous?.generation === lifecycle.generation &&
    previous.revision > lifecycle.revision
  )
    return false;
  states.set(lifecycle.requestId, lifecycle);
  return true;
}

export function hasWaitingApproval(state) {
  return [...requestLifecycles(state).values()].some(
    (value) => value.status === "awaiting_approval",
  );
}

export function waitingRequest(state) {
  return [...requestLifecycles(state).values()].find(
    (value) => value.status === "awaiting_approval",
  );
}

export function sameConversationMessage(existing, incoming) {
  if (incoming.id && existing.id === incoming.id) return true;
  if (isUserInteractionMessage(existing) || isUserInteractionMessage(incoming)) return false;
  if (isApprovalPresentation(existing) || isApprovalPresentation(incoming))
    return false;
  if (!incoming.requestId || existing.requestId !== incoming.requestId)
    return false;
  if (existing.role !== "assistant" || incoming.role !== "assistant")
    return false;
  // Merge the optimistic streaming row into its saved answer. Persisted entries
  // retain their own identities even when they belong to one logical request.
  return !existing.persistedMessageId || !incoming.persistedMessageId;
}

export function mergeConversationMessage(existing, incoming) {
  return {
    ...existing, ...incoming,
    text: incoming.text || existing.text,
    thinkingText: incoming.thinkingText || existing.thinkingText,
  };
}

export function removeStreamingPlaceholder(state, requestId) {
  state.messages = state.messages.filter((message) => {
    if (message.requestId !== requestId || message.role !== "assistant")
      return true;
    if (message.persistedMessageId || isApprovalPresentation(message))
      return true;
    return !message.streaming;
  });
  state.requestMessages.delete(requestId);
}
