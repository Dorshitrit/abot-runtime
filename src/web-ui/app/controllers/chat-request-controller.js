import { ComposerSubmissionRefused, isDefiniteSubmissionRefusal } from "./composer-submission-lifecycle.js";

/** Request effects use an immutable captured payload, never the currently visible draft. */
export function createChatRequestController({
  client, conversationView, conversationSession, isCurrentComposerScope,
  applyConversationChrome, renderSessions,
}) {
  const optimisticRows = new WeakMap();
  function prepareView(attempt) {
    if (!isCurrentComposerScope(attempt.payload.scope)) return;
    conversationView.reset();
    applyConversationChrome();
    renderSessions();
    optimisticRows.set(attempt, conversationSession.appendLocalUserMessage(attempt.payload));
  }

  async function postChatMessage(request) {
    try { return await client.postChatMessage(request); }
    catch (error) {
      if (hasDefiniteChatRejection(error))
        throw new ComposerSubmissionRefused(error.message, { cause: error });
      throw error;
    }
  }

  async function send(attempt) {
    try { return await postChatMessage({ ...attempt.payload, ...attempt.payload.scope, ...attempt.settings }); }
    catch (error) {
      const removeLocalRow = optimisticRows.get(attempt);
      if (isDefiniteSubmissionRefusal(error) && typeof removeLocalRow === "function") removeLocalRow();
      throw error;
    } finally { optimisticRows.delete(attempt); }
  }

  function hasDefiniteChatRejection(error) {
    if (["unsupported_tool_permission_mode", "full_plus_not_supported"].includes(error?.code)) return true;
    return Number.isFinite(error?.status) && error.status >= 400 && error.status < 500;
  }

  return {
    prepareView,
    postChatMessage,
    send,
    activate: (attempt, requestId) => conversationSession.activateRequestForScope(attempt.payload.scope, requestId),
    stopRequest: (scope) => client.stopChatRequest(scope),
  };
}
