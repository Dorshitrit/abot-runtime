export function createChatRequestController({
  state,
  client,
  sessionQueue,
  conversationView,
  conversationSession,
  attachments,
  currentComposerScope,
  isCurrentComposerScope,
  rememberModelSelection,
  applyConversationChrome,
  renderSessions,
  renderAttachments,
  getToolPermissionMode,
  getModelPreference,
  clearQueueRecovery,
  reportQueueFailure,
}) {
  function postChatMessage(request) {
    return client.postChatMessage(request);
  }

  async function sendMessage(text) {
    conversationSession.ensureSession();
    const scope = currentComposerScope();
    conversationView.reset();
    rememberModelSelection();
    applyConversationChrome();
    renderSessions();

    const submittedAttachments = [...state.pendingAttachments];
    attachments.invalidateCompletions();
    state.pendingAttachments = [];
    renderAttachments();

    conversationSession.appendLocalUserMessage({
      text,
      attachments: submittedAttachments,
    });

    let requestId;
    try {
      requestId = await postChatMessage({
        text,
        attachments: submittedAttachments,
        environmentId: scope.environmentId,
        sessionId: scope.sessionId,
        agentMode: state.agentMode,
        toolPermissionMode: getToolPermissionMode(),
        modelPreference: getModelPreference(),
      });
    } catch (error) {
      if (isCurrentComposerScope(scope)) {
        state.pendingAttachments = [
          ...submittedAttachments,
          ...state.pendingAttachments,
        ];
        renderAttachments();
      }
      throw error;
    }

    try {
      const rebound = sessionQueue.rebindBlocked(scope, requestId);
      if (rebound) clearQueueRecovery(scope);
    } catch (error) {
      reportQueueFailure(
        scope,
        `The request started, but the remaining Send next queue is paused: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    conversationSession.activateRequestForScope(scope, requestId);
  }

  return { postChatMessage, sendMessage };
}
