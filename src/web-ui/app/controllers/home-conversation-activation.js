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
  return function activateHomeConversation(draft) {
    if (draft.environmentId !== selectedEnvironmentId()) return false;
    const activateChat = shell.prepareWorkspaceActivation("chat", {
      focus: false,
    });
    if (!activateChat) return false;
    if (!composerQueue.suspendRecoveryForNavigation()) return false;
    if (!activateChat()) return false;
    conversationSession.clearCurrentSessionView();
    state.currentSessionId = draft.sessionId;
    state.pendingAttachments = draft.attachments;
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
