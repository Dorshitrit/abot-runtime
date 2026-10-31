import { buildConversationStatus } from "../lib/conversation-status-model.js";

const SHIMMER_DURATION_MS = 2_800;

function isActiveAssistant(message, activeRequestId) {
  if (message.role !== "assistant") return false;
  if (!message.streaming || !message.requestId) return false;
  return message.requestId === activeRequestId;
}

/** Updates the activity text without replacing the conversation or its scroll position. */
export function createConversationStatus({
  getActiveRequestId,
  getActivityForMessage,
  isConnected = () => true,
  present = (model) => model,
  documentRoot = document,
}) {
  const entries = new Map();
  let progressTimer = null;

  function refresh(message, node) {
    const model = present(buildConversationStatus({
      ...getActivityForMessage(message),
      requestId: message.requestId,
      streaming: isActiveAssistant(message, getActiveRequestId()),
      connected: isConnected(),
    }));
    node.hidden = !model;
    const elapsed = model?.progressAt
      ? ` · updated ${Math.max(0, Math.floor((Date.now() - model.progressAt) / 1000))}s ago`
      : "";
    const label = (model?.label || "") + elapsed;
    if (node.textContent !== label) node.textContent = label;
    node.classList.toggle("is-animated", Boolean(model?.animate));
    return Boolean(model?.progressAt);
  }

  function createNode(message) {
    if (!isActiveAssistant(message, getActiveRequestId())) return null;
    const node = documentRoot.createElement("span");
    node.className = "conversation-status";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    node.setAttribute("aria-atomic", "true");
    node.setAttribute("dir", "ltr");
    node.setAttribute("lang", "en");
    node.style.setProperty(
      "--status-shimmer-duration",
      `${SHIMMER_DURATION_MS}ms`,
    );
    // Keep the light sweep in phase when a streaming render recreates the row.
    node.style.setProperty(
      "--status-shimmer-delay",
      `${-(Date.now() % SHIMMER_DURATION_MS)}ms`,
    );
    entries.set(message.id, { message, node });
    render();
    return node;
  }

  function render() {
    clearTimeout(progressTimer);
    let hasProgress = false;
    for (const { message, node } of entries.values())
      hasProgress = refresh(message, node) || hasProgress;
    progressTimer = hasProgress ? setTimeout(render, 1000) : null;
  }

  function reset() {
    clearTimeout(progressTimer);
    progressTimer = null;
    entries.clear();
  }

  return { createNode, render, reset };
}
