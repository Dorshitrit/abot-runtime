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

  function createNode(message, { allowEmpty = false } = {}) {
    const shouldMountReasoning = allowEmpty || Boolean(message.thinkingText);
    if (!shouldMountReasoning) return null;
    const details = documentRoot.createElement("details");
    details.className = "conversation-reasoning";
    details.open = expandedMessages.has(message.id);
    const summary = documentRoot.createElement("summary");
    summary.className = "conversation-reasoning-toggle";
    const content = documentRoot.createElement("div");
    content.className = "thinking-body";
    summary.appendChild(content);
    details.appendChild(summary);
    const binding = { details, summary, content, text: undefined };
    renderedMessages.set(message.id, binding);
    updateNode(message);
    details.addEventListener("toggle", () => {
      if (renderedMessages.get(message.id) !== binding) return;
      content.inert = !details.open;
      if (details.open) expandedMessages.add(message.id);
      else expandedMessages.delete(message.id);
    });
    return details;
  }

  function updateNode(message) {
    const binding = renderedMessages.get(message.id);
    if (!binding) return false;
    const text = message.thinkingText || "";
    if (binding.text === text) return false;
    binding.text = text;
    binding.details.hidden = !text;
    binding.summary.setAttribute("aria-label", text);
    applyTextDirection(binding.content, text);
    binding.content.innerHTML = renderMarkdown(text);
    binding.content.inert = !binding.details.open;
    return true;
  }

  function update(messages) {
    let changed = false;
    for (const message of messages) {
      if (updateNode(message)) changed = true;
    }
    return changed;
  }

  function reset() {
    expandedMessages.clear();
    renderedMessages.clear();
  }

  return { beginRender, createNode, update, reset };
}
