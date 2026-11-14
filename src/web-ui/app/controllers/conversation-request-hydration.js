import { presentFailedResponseHistory } from "../lib/failed-response-history.js";
import { isCommandRequest, rememberCommandRun } from "../lib/command-runs.js";
import { isUserInteractionMessage } from "../lib/user-interaction-event.js";
import { isStoppedRequest, restoreStoppedResponses } from "../lib/request-stop-state.js";
import { isApprovalPresentation, rememberRequestLifecycle } from "../lib/request-lifecycle-view.js";
import { textOf } from "../lib/text-format.js";
import { canRestoreSnapshotQueue } from "./history-pagination.js";

function isBindableResponse(message) {
  if (isUserInteractionMessage(message)) return false;
  if (message.role !== "assistant" || !message.requestId) return false;
  return !isApprovalPresentation(message);
}
function isStreamingRequest(request) {
  if (!request.requestId) return false;
  return request.status === "streaming";
}
function isQueuedTerminalRequest(request, queued) {
  if (textOf(request.requestId) !== queued?.waitForRequestId) return false;
  return request.status === "completed" || request.status === "failed";
}
function mergeRefreshedRequests(previous, fresh) {
  // A latest-page fetch includes every active request. Keep metadata for the
  // displayed historical page, but never revive an older active projection.
  const requests = new Map(previous
    .filter((request) => !isStreamingRequest(request) && request.status !== "awaiting_approval")
    .map((request) => [request.requestId, request]));
  for (const request of fresh) requests.set(request.requestId, request);
  return [...requests.values()];
}
function requestsForEventRestoration(requests, streamingRequestIds, appendEvents) {
  if (!appendEvents) return requests;
  // Existing live rows already contain received tokens. Resume their events only after lastSeq.
  return requests.map((request) => streamingRequestIds.has(request.requestId) ? { ...request, events: [] } : request);
}

/** Shared snapshot lifecycle restoration; the caller owns the visible history window. */
export function createConversationRequestHydration({
  state, client, selectedEnvironmentId, sessionQueue, applyConversationChrome, renderSessions,
  updateComposerSendState, reportQueueFailure, activeAssistantForRequest, restoreSessionEventState,
  subscribeSession, subscribeRequest, replayRequestEvents, resumeRequest, recoverBlockedQueue, drainQueuedMessage, renderMessages,
}) {
  function isCurrentHydration(scope, viewVersion) {
    if (scope.environmentId !== selectedEnvironmentId()) return false;
    if (scope.sessionId !== state.currentSessionId) return false;
    return viewVersion === state.sessionViewVersion;
  }
  function canRestoreStreamingRequest(request, scope) {
    if (!isStreamingRequest(request)) return false;
    if (!isCommandRequest(request)) return true;
    return rememberCommandRun(state, scope, request.requestId);
  }
  async function restore(requests, { appendEvents = false } = {}) {
    const scope = { environmentId: selectedEnvironmentId(), sessionId: state.currentSessionId };
    const viewVersion = state.sessionViewVersion;
    await sessionQueue.refresh?.();
    if (!isCurrentHydration(scope, viewVersion)) return false;
    const waitingRequestId = sessionQueue.peek(scope)?.waitForRequestId;
    if (!canRestoreSnapshotQueue({ requests }, waitingRequestId)) {
      const snapshot = await client.loadSession(scope.sessionId, scope.environmentId, { waitingRequestId });
      if (!isCurrentHydration(scope, viewVersion)) return false;
      requests = mergeRefreshedRequests(requests, snapshot.requests || []);
    }
    for (const message of state.messages) {
      if (!isBindableResponse(message)) continue;
      state.requestMessages.set(message.requestId, message.id);
    }
    for (const request of requests) rememberRequestLifecycle(state, request.lifecycle);
    applyConversationChrome();
    renderSessions();
    const streamingRequests = requests.filter((request) => canRestoreStreamingRequest(request, scope));
    const streamingRequestIds = new Set(streamingRequests
      .map((request) => textOf(request.requestId)));
    state.activeRequestId = [...streamingRequestIds][0] || "";
    for (const request of streamingRequests) {
      if (!isCommandRequest(request)) activeAssistantForRequest(request.requestId);
    }
    updateComposerSendState();
    const chatRequests = requests.filter((request) => !isCommandRequest(request));
    restoreStoppedResponses(state.messages, chatRequests);
    presentFailedResponseHistory(state.messages, chatRequests);
    restoreSessionEventState(requestsForEventRestoration(requests, streamingRequestIds, appendEvents), streamingRequestIds, appendEvents);
    for (const request of streamingRequests) {
      const requestId = textOf(request.requestId);
      subscribeRequest(requestId);
      await replayRequestEvents(requestId, viewVersion);
      if (!isCurrentHydration(scope, viewVersion)) return false;
      if (!canRestoreStreamingRequest(request, scope)) continue;
      resumeRequest(requestId);
    }
    if (state.activeRequestId) { renderMessages(); return true; }
    await recoverBlockedQueue(scope);
    if (!isCurrentHydration(scope, viewVersion)) return false;
    const queued = sessionQueue.peek(scope);
    const terminal = requests.find((request) => isQueuedTerminalRequest(request, queued));
    if (terminal) await drainQueuedMessage({ ...scope, terminalRequestId: terminal.requestId, cancelled: isStoppedRequest(terminal) });
    if (!isCurrentHydration(scope, viewVersion)) return false;
    renderMessages();
    return true;
  }
  async function rehydrate(requests) {
    subscribeSession(state.currentSessionId);
    return restore(requests, { appendEvents: true });
  }
  return { restore, rehydrate };
}
