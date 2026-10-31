import { isApprovalPresentation } from "./request-lifecycle-view.js";
import {
  contextReplayBinding,
  isContextReplayCurrent,
} from "./context-window-replay.js";
import {
  isUserInteractionMessage,
  projectUserInteractionEvent,
} from "./user-interaction-event.js";

export function acceptsUserInteractionScope(state, event, environmentId) {
  const replay = contextReplayBinding(event);
  if (replay && !isContextReplayCurrent(replay, state, environmentId)) return false;
  const eventEnvironment = event.environment || event.environmentId;
  if (eventEnvironment && eventEnvironment !== environmentId) return false;
  if (event.sessionId && event.sessionId !== state.currentSessionId) return false;
  const generation = state.requestLifecycles?.get(event.requestId)?.generation;
  if (generation && event.generation && generation !== event.generation) return false;
  return true;
}

function belongsAfterInteraction(message, incoming) {
  if (message.requestId !== incoming.requestId) return false;
  if (isUserInteractionMessage(message))
    return message.interactionSequence > incoming.interactionSequence;
  if (message.role === "assistant" && !isApprovalPresentation(message)) return true;
  const timestamp = new Date(message.createdAt).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return timestamp > Date.parse(incoming.createdAt);
}

function interactionInsertIndex(messages, incoming) {
  const following = messages.findIndex((message) => belongsAfterInteraction(message, incoming));
  if (following >= 0) return following;
  const lastRequestMessage = messages.findLastIndex((message) => message.requestId === incoming.requestId);
  return lastRequestMessage < 0 ? messages.length : lastRequestMessage + 1;
}

/** Transcript paging replaces response rows; keep event rows in their request order. */
export function orderRequestInteractionMessages(messages) {
  const interactions = messages.filter(isUserInteractionMessage);
  if (interactions.length === 0) return messages;
  const ordered = messages.filter((message) => !isUserInteractionMessage(message));
  for (const interaction of interactions)
    ordered.splice(interactionInsertIndex(ordered, interaction), 0, interaction);
  return ordered;
}

/** Client-only rows never enter the persisted transcript or the active-response map. */
export function applyUserInteractionEvent(state, event, environmentId) {
  if (!acceptsUserInteractionScope(state, event, environmentId)) return false;
  const incoming = projectUserInteractionEvent(event);
  if (!incoming || !Array.isArray(state.messages)) return false;
  if (state.messages.some((message) => message.id === incoming.id)) return false;
  const index = interactionInsertIndex(state.messages, incoming);
  state.messages.splice(index, 0, incoming);
  return true;
}
