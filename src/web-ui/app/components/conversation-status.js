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
  documentRoot = document,
}) {
  const entries = new Map();

  function refresh(message, node) {
    const model = buildConversationStatus({
      ...getActivityForMessage(message),
      requestId: message.requestId,
      streaming: isActiveAssistant(message, getActiveRequestId()),
      connected: isConnected(),
    });
    node.hidden = !model;
    const label = model?.label || "";
    if (node.textContent !== label) node.textContent = label;
    node.classList.toggle("is-animated", Boolean(model?.animate));
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
    refresh(message, node);
    return node;
  }

  function render() {
    for (const { message, node } of entries.values()) refresh(message, node);
  }

  function reset() {
    entries.clear();
  }

  return { createNode, render, reset };
}
