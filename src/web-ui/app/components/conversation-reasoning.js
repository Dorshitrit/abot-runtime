import { applyTextDirection, renderMarkdown } from "../lib/text-format.js";

export function createConversationReasoning({ documentRoot = document } = {}) {
  const expandedMessages = new Set();
  const renderedMessages = new Map();

  function beginRender(messages) {
    renderedMessages.clear();
    const messageIds = new Set(messages.map((message) => message.id));
    for (const id of expandedMessages) {
      if (!messageIds.has(id)) expandedMessages.delete(id);
    }
  }

  function createNode(message) {
    if (!message.thinkingText) return null;
    const details = documentRoot.createElement("details");
    details.className = "conversation-reasoning";
    details.open = expandedMessages.has(message.id);
    const summary = documentRoot.createElement("summary");
    summary.className = "conversation-reasoning-toggle";
    summary.setAttribute("aria-label", message.thinkingText);
    const content = documentRoot.createElement("div");
    content.className = "thinking-body";
    applyTextDirection(content, message.thinkingText);
    content.innerHTML = renderMarkdown(message.thinkingText);
    content.inert = !details.open;
    summary.appendChild(content);
    details.appendChild(summary);
    renderedMessages.set(message.id, details);
    details.addEventListener("toggle", () => {
      if (renderedMessages.get(message.id) !== details) return;
      content.inert = !details.open;
      if (details.open) expandedMessages.add(message.id);
      else expandedMessages.delete(message.id);
    });
    return details;
  }

  function reset() {
    expandedMessages.clear();
    renderedMessages.clear();
  }

  return { beginRender, createNode, reset };
}
