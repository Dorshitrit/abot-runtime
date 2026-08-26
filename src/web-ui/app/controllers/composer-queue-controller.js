export function createComposerQueueController({
  state,
  dom,
  queue,
  selectedEnvironmentId,
  getToolPermissionMode,
  getModelPreference,
  rememberModelSelection,
  attachments,
  updateSendState,
  postChatMessage,
  appendLocalUserMessage,
  activateRequestForScope,
  renderMessages,
  setMessageStatus,
  recordControlEvent,
  resizeComposer,
}) {
  const scopeKey = (scope) =>
    JSON.stringify([scope.environmentId, scope.sessionId]);
  const currentScope = () => ({
    environmentId: selectedEnvironmentId(),
    sessionId: state.currentSessionId,
  });
  const isCurrentScope = (scope) =>
    selectedEnvironmentId() === scope.environmentId &&
    state.currentSessionId === scope.sessionId;
  const isCurrentDraining = () =>
    state.composerQueueDrainingScopes.has(scopeKey(currentScope()));
  const queuedCount = () => {
    const scope = currentScope();
    if (!scope.environmentId || !scope.sessionId) return 0;
    return queue.list(scope).length;
  };

  async function enqueue(text) {
    const scope = currentScope();
    const waitForRequestId = state.activeRequestId;
    if (!scope.sessionId || !waitForRequestId) {
      throw new Error("Send next requires an active request.");
    }
    const queuedAttachments = [...state.pendingAttachments];
    rememberModelSelection();
    queue.enqueue(scope, {
      waitForRequestId,
      text,
      attachments: queuedAttachments,
      agentMode: state.agentMode,
      toolPermissionMode: getToolPermissionMode(),
      modelPreference: getModelPreference(),
    });
    attachments.invalidateCompletions();
    state.pendingAttachments = [];
    attachments.render();
  }

  function reportFailure(scope, summary) {
    if (!isCurrentScope(scope)) return;
    state.messages.push({
      id: `queue-error-${Date.now()}`,
      role: "assistant",
      text: summary,
      createdAt: Date.now(),
      requestId: "",
      streaming: false,
    });
    renderMessages();
    setMessageStatus("Send next queue is paused.");
    recordControlEvent({
      type: "control",
      name: "Send next queue paused",
      tone: "failed",
      summary,
    });
  }

  function restoreText(text, scope) {
    if (!isCurrentScope(scope)) return;
    const current = dom.composerInput.value.trim();
    dom.composerInput.value = current ? `${text}\n${current}` : text;
    resizeComposer();
  }

  function restoreItem(item, scope) {
    if (!isCurrentScope(scope)) return false;
    restoreText(item.text, scope);
    state.pendingAttachments = [
      ...item.attachments,
      ...state.pendingAttachments,
    ];
    attachments.render();
    return true;
  }

  function clearRecovery(scope) {
    const active = state.activeComposerQueueRecovery;
    if (!active || scopeKey(active.scope) !== scopeKey(scope)) return;
    state.composerQueueRecoveredReleaseTokens.delete(active.releaseToken);
    state.activeComposerQueueRecovery = null;
  }

  async function drain({ environmentId, sessionId, terminalRequestId }) {
    const scope = { environmentId, sessionId };
    const key = scopeKey(scope);
    if (state.composerQueueDrainingScopes.has(key)) return;
    state.composerQueueDrainingScopes.add(key);
    if (isCurrentScope(scope)) updateSendState();
    let released;
    try {
      released = queue.releaseForTerminal(scope, terminalRequestId);
    } catch (error) {
      reportFailure(
        scope,
        `The queued message was not released: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      state.composerQueueDrainingScopes.delete(key);
      if (isCurrentScope(scope)) updateSendState();
      return;
    }
    if (!released) {
      state.composerQueueDrainingScopes.delete(key);
      if (isCurrentScope(scope)) updateSendState();
      return;
    }
    updateSendState();
    const { item, releaseToken } = released;
    let requestId;
    try {
      requestId = await postChatMessage({
        text: item.text,
        attachments: item.attachments,
        environmentId,
        sessionId,
        agentMode: item.agentMode,
        toolPermissionMode: item.toolPermissionMode,
        modelPreference: item.modelPreference,
      });
    } catch (error) {
      const restored = restoreItem(item, scope);
      if (restored) {
        state.composerQueueRecoveredReleaseTokens.add(releaseToken);
        state.activeComposerQueueRecovery = {
          scope: { ...scope },
          releaseToken,
        };
      }
      reportFailure(
        scope,
        `The queued message could not be confirmed and will not be retried automatically: ${
          error instanceof Error ? error.message : String(error)
        }.${restored ? " It was restored to the composer for a manual send." : ""}`,
      );
      state.composerQueueDrainingScopes.delete(key);
      if (isCurrentScope(scope)) updateSendState();
      return;
    }
    let queueBound = false;
    try {
      queueBound = queue.bindReleasedSuccess(scope, releaseToken, requestId);
    } catch (error) {
      queueBound = null;
      reportFailure(
        scope,
        `The queued message started, but the remaining queue is paused: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (queueBound === false) {
      reportFailure(
        scope,
        "The queued message started, but the remaining queue could not be rebound and is paused.",
      );
    }
    if (isCurrentScope(scope)) {
      appendLocalUserMessage({
        text: item.text,
        attachments: item.attachments,
        requestId,
      });
    }
    state.composerQueueDrainingScopes.delete(key);
    activateRequestForScope(scope, requestId);
  }

  function suspendRecoveryForNavigation() {
    const active = state.activeComposerQueueRecovery;
    if (!active) return true;
    try {
      const blockedRelease = queue.getBlockedRelease(active.scope);
      if (
        !blockedRelease ||
        blockedRelease.releaseToken !== active.releaseToken
      ) {
        clearRecovery(active.scope);
        return true;
      }
      const updated = queue.updateBlockedRelease(
        active.scope,
        active.releaseToken,
        {
          ...blockedRelease.item,
          text: dom.composerInput.value,
          attachments: [...state.pendingAttachments],
        },
      );
      if (!updated)
        throw new Error("blocked release changed before it was saved");
    } catch (error) {
      reportFailure(
        active.scope,
        `The recovered Send next draft could not be saved before navigation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
    dom.composerInput.value = "";
    resizeComposer();
    attachments.clear({ cleanup: false });
    clearRecovery(active.scope);
    return true;
  }

  function recoverForManualSend(scope) {
    let blockedRelease;
    try {
      blockedRelease = queue.getBlockedRelease(scope);
    } catch (error) {
      reportFailure(
        scope,
        `The paused Send next message could not be recovered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
    if (
      !blockedRelease ||
      state.composerQueueRecoveredReleaseTokens.has(blockedRelease.releaseToken)
    ) {
      return false;
    }
    if (!restoreItem(blockedRelease.item, scope)) return false;
    state.composerQueueRecoveredReleaseTokens.add(blockedRelease.releaseToken);
    state.activeComposerQueueRecovery = {
      scope: { ...scope },
      releaseToken: blockedRelease.releaseToken,
    };
    reportFailure(
      scope,
      "A queued message could not be confirmed after the interruption. It was restored to the composer for review and will not be sent automatically.",
    );
    return true;
  }

  return {
    clearRecovery,
    currentScope,
    drain,
    enqueue,
    isCurrentDraining,
    isCurrentScope,
    queuedCount,
    recoverForManualSend,
    reportFailure,
    restoreText,
    scopeKey,
    suspendRecoveryForNavigation,
  };
}
