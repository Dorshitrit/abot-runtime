import { textOf } from "../lib/text-format.js";

function latestDisplayedAssistant(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") return messages[index];
  }
  return null;
}

function displayedAssistantReadBoundary(messages) {
  const message = latestDisplayedAssistant(messages);
  if (!message) return null;
  if (message.streaming === true) return null;
  const numericId = Number(textOf(message.id).replace(/^msg-/, ""));
  const hasPersistedMessageId = Number.isSafeInteger(numericId) && numericId > 0;
  if (hasPersistedMessageId) return { readThroughMessageId: numericId };
  const requestId = textOf(message.requestId).trim();
  if (!requestId) return null;
  return {
    readThroughMessageId: null,
    readThroughRequestId: requestId,
  };
}

export function createConversationReadStateController({
  state,
  client,
  selectedEnvironmentId,
  applyReadState,
  recordControlEvent,
  isConversationVisible = () => true,
  scheduleTask = (callback) => window.setTimeout(callback, 0),
}) {
  function isCurrentReadScope(scope) {
    if (selectedEnvironmentId() !== scope.environmentId) return false;
    if (state.currentSessionId !== scope.sessionId) return false;
    return state.sessionViewVersion === scope.viewVersion;
  }

  function canMarkConversationRead(scope) {
    if (!scope.sessionId) return false;
    if (!isConversationVisible()) return false;
    return isCurrentReadScope(scope);
  }

  async function markSessionRead(scope, boundary) {
    try {
      const result = await client.markSessionRead({
        sessionId: scope.sessionId,
        environmentId: scope.environmentId,
        ...boundary,
      });
      if (selectedEnvironmentId() !== scope.environmentId) return;
      applyReadState(scope.sessionId, result.readState);
    } catch (error) {
      if (selectedEnvironmentId() !== scope.environmentId) return;
      recordControlEvent({
        type: "control",
        name: "Read state update failed",
        tone: "failed",
        summary: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function markCurrentSessionReadSoon() {
    const scope = {
      environmentId: selectedEnvironmentId(),
      sessionId: state.currentSessionId,
      viewVersion: state.sessionViewVersion,
    };
    if (!canMarkConversationRead(scope)) return;
    const boundary = displayedAssistantReadBoundary(state.messages);
    if (!boundary) return;
    scheduleTask(() => {
      if (!canMarkConversationRead(scope)) return;
      void markSessionRead(scope, boundary);
    });
  }

  return { markCurrentSessionReadSoon };
}
