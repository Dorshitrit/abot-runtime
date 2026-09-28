export function createSparkConversationActions({
  getScope,
  getMessages,
  getActiveRequestId = () => "",
  preferences,
  archiveSession,
  onArchived = () => {},
  notify = () => {},
  documentRoot = document,
}) {
  function canReview(message, scope) {
    if (!scope.environmentId || !scope.sessionId || !preferences) return false;
    if (getActiveRequestId() || message.streaming || !message.sparkProposalId) return false;
    const messages = getMessages();
    if (messages.some((item) => item.role === "user")) return false;
    if (messages.find((item) => item.role === "assistant") !== message) return false;
    if (preferences.loadSessionSidebar(scope.environmentId).archivedSessionIds.includes(scope.sessionId)) return false;
    return !preferences.hasKeptSparkConversation(scope.environmentId, scope.sessionId);
  }

  function createNode(message, { onKept = () => {} } = {}) {
    const scope = getScope();
    if (!canReview(message, scope)) return null;
    const row = documentRoot.createElement("div");
    row.className = "spark-conversation-actions";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "ABot Spark conversation");

    function choose(action) {
      const current = getScope();
      if (current.environmentId !== scope.environmentId || current.sessionId !== scope.sessionId) return;
      if (!canReview(message, scope)) return;
      try {
        if (action === "keep") {
          preferences.keepSparkConversation(scope.environmentId, scope.sessionId);
          row.hidden = true;
          onKept();
          notify("Conversation kept", "success");
          return;
        }
        if (archiveSession?.(scope.sessionId) !== true) return;
        row.hidden = true;
        onArchived();
      } catch {
        notify("Could not save your choice in this browser. Please try again.", "failed");
      }
    }

    for (const [action, label] of [["keep", "Keep"], ["archive", "Not interested"]]) {
      const button = documentRoot.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.className = "spark-conversation-choice";
      if (action === "archive") button.title = "Archive this conversation in this browser";
      button.addEventListener("click", () => choose(action));
      row.appendChild(button);
    }
    return row;
  }

  return { createNode };
}
