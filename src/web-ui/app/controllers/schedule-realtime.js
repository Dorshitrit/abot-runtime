import { normalizeScheduleReference } from "../lib/schedule-message.js";
import { textOf } from "../lib/text-format.js";

export function isScheduleTriggerForConversation(
  message,
  sessionId,
  environmentId,
) {
  if (!sessionId || message.sessionId !== sessionId) return false;
  return isScheduleTriggerInEnvironment(message, environmentId);
}

function isScheduleTriggerInEnvironment(message, environmentId) {
  if (!textOf(message.sessionId)) return false;
  if (textOf(message.environment || message.environmentId) !== environmentId)
    return false;
  if (!textOf(message.requestId) || !textOf(message.messageId)) return false;
  return Boolean(normalizeScheduleReference(message.schedule));
}

export function createScheduleRealtimeController({
  state,
  selectedEnvironmentId,
  addOrMergeMessage,
  normalizeChatMessage,
  activeAssistantForRequest,
  renderMessages,
  updateComposerSendState,
  setMessageActivityStatus,
  trackSeq,
  loadSessions,
}) {
  const scheduledRequests = new Map();

  function hasRecordedTrigger(message) {
    return (state.messages || []).some(
      (item) => item.schedule?.runId === message.schedule.runId,
    );
  }

  function hasDifferentActiveRequest(requestId) {
    if (!state.activeRequestId) return false;
    return state.activeRequestId !== requestId;
  }

  function isForegroundScheduledRequest(message) {
    if (message.sessionId !== state.currentSessionId) return false;
    return message.requestId === state.activeRequestId;
  }

  function scheduledTerminalScope(message) {
    const tracked = scheduledRequests.get(message.requestId);
    if (tracked) return tracked;
    if (message.requestOrigin !== "schedule") return undefined;
    const environmentId = textOf(message.environment || message.environmentId);
    if (!environmentId.trim()) return undefined;
    if (!textOf(message.requestId).trim()) return undefined;
    if (!textOf(message.sessionId).trim()) return undefined;
    return { sessionId: message.sessionId, environmentId };
  }

  function handleScheduledTerminal(message) {
    if (message.type !== "completed" && message.type !== "failed") return false;
    const scope = scheduledTerminalScope(message);
    if (!scope) return message.requestOrigin === "schedule";
    if (message.sessionId !== scope.sessionId) return true;
    const environmentId =
      textOf(message.environment || message.environmentId) ||
      scope.environmentId;
    if (environmentId !== scope.environmentId) return true;
    scheduledRequests.delete(message.requestId);
    if (environmentId !== selectedEnvironmentId()) return true;
    if (message.sessionDeleted === true) return true;
    if (isForegroundScheduledRequest(message)) return false;
    void loadSessions();
    return true;
  }

  function handle(message) {
    if (handleScheduledTerminal(message)) return true;
    if (message.type !== "event" || message.name !== "schedule.triggered")
      return false;
    if (!isScheduleTriggerInEnvironment(message, selectedEnvironmentId()))
      return true;
    if (message.sessionDeleted === true) return true;
    scheduledRequests.set(message.requestId, {
      sessionId: message.sessionId,
      environmentId: selectedEnvironmentId(),
    });
    if (hasRecordedTrigger(message)) return true;
    if (
      !isScheduleTriggerForConversation(
        message,
        state.currentSessionId,
        selectedEnvironmentId(),
      )
    )
      return true;
    if (hasDifferentActiveRequest(message.requestId)) return true;
    const userMessage = normalizeChatMessage({
      id: message.messageId,
      role: "user",
      requestId: message.requestId,
      text: message.text,
      createdAt: message.createdAt,
      schedule: message.schedule,
    });
    addOrMergeMessage(userMessage);
    state.activeRequestId = message.requestId;
    activeAssistantForRequest(message.requestId);
    trackSeq(message);
    renderMessages();
    updateComposerSendState();
    setMessageActivityStatus("Scheduled task is running.", true);
    return true;
  }
  return { handle };
}
