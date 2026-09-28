import {
  rememberRequestLifecycle,
  removeStreamingPlaceholder,
} from "../lib/request-lifecycle-view.js";

export function createRequestLifecycleController(options) {
  const {
    state,
    addOrMergeMessage,
    normalizeChatMessage,
    activeAssistantForRequest,
    updateComposerSendState,
    renderMessages,
    setMessageActivityStatus,
    markCurrentSessionReadSoon,
    cancelScheduledMessageRender,
    cancelScheduledThinkingRender,
  } = options;

  function handle(message) {
    if (message.name !== "request.lifecycle.changed") return false;
    const lifecycle = message.lifecycle;
    if (!rememberRequestLifecycle(state, lifecycle)) return true;
    const requestId = lifecycle.requestId;
    const waiting = lifecycle.status === "awaiting_approval";
    if (waiting) removeStreamingPlaceholder(state, requestId);
    if (message.message)
      addOrMergeMessage(normalizeChatMessage(message.message));
    if (lifecycle.status === "streaming") {
      state.activeRequestId = requestId;
      activeAssistantForRequest(requestId).streaming = true;
      setMessageActivityStatus("ABot is working.");
    } else {
      for (const entry of state.messages) {
        if (entry.requestId === requestId) entry.streaming = false;
        if (
          entry.requestId === requestId &&
          entry.approvalRequest?.state === "pending" &&
          !waiting
        ) {
          entry.approvalRequest = {
            ...entry.approvalRequest,
            state: "cancelled",
          };
        }
      }
      if (waiting && state.activeRequestId === requestId)
        state.activeRequestId = "";
      cancelScheduledMessageRender();
      cancelScheduledThinkingRender();
      if (waiting) setMessageActivityStatus("Waiting for your approval.");
      markCurrentSessionReadSoon();
    }
    updateComposerSendState();
    renderMessages();
    return true;
  }
  return { handle };
}
