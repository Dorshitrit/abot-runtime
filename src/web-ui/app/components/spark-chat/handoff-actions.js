function isPersistedInitiative(message) {
  if (message.role !== "assistant" || message.streaming) return false;
  if (message.persistedMessageId == null) return false;
  return Boolean(message.sparkProposalId);
}

function sameSourceMessage(current, source) {
  if (current.persistedMessageId !== source.persistedMessageId) return false;
  if (current.createdAt !== source.createdAt) return false;
  return current.requestId === source.requestId;
}

export function createSparkHandoffActions({
  getScope, getMessages, client, captureNavigation, onOpened, onChange = () => {},
  notify, documentRoot = document,
}) {
  const pending = new Set();
  function createNode(message) {
    if (!isPersistedInitiative(message)) return null;
    const scope = getScope();
    const identity = JSON.stringify([scope, message.persistedMessageId, message.createdAt, message.requestId]);
    const row = documentRoot.createElement("div");
    row.className = "spark-handoff-actions";
    const button = documentRoot.createElement("button");
    button.type = "button";
    button.className = "spark-handoff-button";
    button.textContent = "Open a session about this";
    button.disabled = !message.sparkHandoffAvailable || pending.has(identity);
    row.appendChild(button);
    if (!message.sparkHandoffAvailable) {
      const explanation = documentRoot.createElement("p");
      explanation.textContent = "The context for this older suggestion wasn’t saved.";
      row.appendChild(explanation);
    }
    function sourceIsCurrent() {
      const current = getScope();
      if (current.environmentId !== scope.environmentId) return false;
      if (current.sessionId !== scope.sessionId || current.viewVersion !== scope.viewVersion) return false;
      return getMessages().some((candidate) => sameSourceMessage(candidate, message));
    }
    async function open() {
      if (button.disabled || pending.has(identity) || !sourceIsCurrent()) return;
      const navigate = captureNavigation();
      pending.add(identity); button.disabled = true;
      try {
        const result = await client.createSparkHandoffSession({ message: {
          id: message.persistedMessageId, createdAt: message.createdAt, requestId: message.requestId || null,
        } }, scope.environmentId);
        if (!sourceIsCurrent()) return;
        if (await navigate(result.sessionId)) onOpened();
      } catch (error) {
        if (sourceIsCurrent()) notify(error.message || "Could not open a session for this suggestion.", "failed");
      } finally { pending.delete(identity); if (sourceIsCurrent()) onChange(); }
    }
    button.addEventListener("click", () => void open());
    return row;
  }
  return { createNode };
}
