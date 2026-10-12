import { createConversationWorkspaceActivation } from "./conversation-workspace-activation.js";

export function createHomeConversationActivation({
  state,
  shell,
  conversationSession,
  composerQueue,
  preferences,
  selectedEnvironmentId,
  renderSessions,
  renderMessages,
  applyModelSelection,
  setCurrentTitle,
  updateComposerSendState,
}) {
  const activate = createConversationWorkspaceActivation({ state, shell, composerQueue, selectedEnvironmentId });
  return async function activateHomeConversation(draft) {
    if (draft.environmentId !== selectedEnvironmentId()) return false;
    if (!await activate()) return false;
    if (draft.environmentId !== selectedEnvironmentId()) return false;
    conversationSession.clearCurrentSessionView();
    state.currentSessionId = draft.sessionId;
    preferences.saveSessionIdForEnvironment(
      draft.environmentId,
      draft.sessionId,
    );
    setCurrentTitle(draft.sessionId);
    applyModelSelection();
    conversationSession.subscribeSession(draft.sessionId);
    updateComposerSendState();
    renderSessions();
    renderMessages();
    return true;
  };
}
