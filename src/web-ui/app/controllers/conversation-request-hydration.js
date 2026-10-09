import { isStoppedRequest, restoreStoppedResponses } from "../lib/request-stop-state.js";
import { isApprovalPresentation, rememberRequestLifecycle } from "../lib/request-lifecycle-view.js";
import { textOf } from "../lib/text-format.js";
import { canRestoreSnapshotQueue } from "./history-pagination.js";

function isBindableResponse(message) {
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
  async function restore(requests, { appendEvents = false } = {}) {
    const scope = { environmentId: selectedEnvironmentId(), sessionId: state.currentSessionId };
    const viewVersion = state.sessionViewVersion;
    for (const message of state.messages) {
      if (!isBindableResponse(message)) continue;
      state.requestMessages.set(message.requestId, message.id);
    }
    for (const request of requests) rememberRequestLifecycle(state, request.lifecycle);
    applyConversationChrome();
    renderSessions();
    const streamingRequestIds = new Set(requests
      .filter(isStreamingRequest)
      .map((request) => textOf(request.requestId)));
    if (streamingRequestIds.size === 1) {
      const [streamingRequestId] = streamingRequestIds;
      try { sessionQueue.rebindBlocked(scope, streamingRequestId); }
      catch (error) {
        reportQueueFailure(scope, `The active request was restored, but the remaining Send next queue is paused: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    state.activeRequestId = [...streamingRequestIds][0] || "";
    updateComposerSendState();
    for (const requestId of streamingRequestIds) activeAssistantForRequest(requestId);
    restoreStoppedResponses(state.messages, requests);
    restoreSessionEventState(requestsForEventRestoration(requests, streamingRequestIds, appendEvents), streamingRequestIds, appendEvents);
    for (const requestId of streamingRequestIds) {
      subscribeRequest(requestId);
      await replayRequestEvents(requestId, viewVersion);
      if (!isCurrentHydration(scope, viewVersion)) return false;
      resumeRequest(requestId);
    }
    if (state.activeRequestId) { renderMessages(); return true; }
    recoverBlockedQueue(scope);
    const queued = sessionQueue.peek(scope);
    const terminal = requests.find((request) => isQueuedTerminalRequest(request, queued));
    if (terminal) await drainQueuedMessage({ ...scope, terminalRequestId: terminal.requestId, cancelled: isStoppedRequest(terminal) });
    if (!isCurrentHydration(scope, viewVersion)) return false;
    renderMessages();
    return true;
  }
  async function rehydrate(requests) {
    const scope = { environmentId: selectedEnvironmentId(), sessionId: state.currentSessionId };
    const viewVersion = state.sessionViewVersion;
    const waitingRequestId = sessionQueue.peek(scope)?.waitForRequestId;
    if (!canRestoreSnapshotQueue({ requests }, waitingRequestId)) {
      const snapshot = await client.loadSession(scope.sessionId, scope.environmentId, { waitingRequestId });
      if (!isCurrentHydration(scope, viewVersion)) return false;
      requests = snapshot.requests || [];
    }
    subscribeSession(scope.sessionId);
    return restore(requests, { appendEvents: true });
  }
  return { restore, rehydrate };
}
