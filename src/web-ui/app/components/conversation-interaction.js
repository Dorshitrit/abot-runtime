import { applyTextDirection, renderMarkdown } from "../lib/text-format.js";
import { isUserInteractionMessage } from "../lib/user-interaction-event.js";

function canHostProgressUpdates(message) {
  if (isUserInteractionMessage(message)) return false;
  if (message.role !== "assistant") return false;
  return Boolean(message.requestId);
}

function isStandaloneProgressAnchor(message, host, updates) {
  if (host) return false;
  return updates[0] === message;
}

/** Presentation only: keep canonical messages and approval continuation binding intact. */
export function projectConversationInteractionEntries(messages) {
  const hosts = new Map();
  const groups = new Map();
  for (const message of messages) {
    if (canHostProgressUpdates(message)) hosts.set(message.requestId, message);
    if (!isUserInteractionMessage(message)) continue;
    const updates = groups.get(message.requestId) || [];
    updates.push(message);
    groups.set(message.requestId, updates);
  }
  return messages.flatMap((message) => {
    const updates = groups.get(message.requestId) || [];
    const host = hosts.get(message.requestId);
    if (!isUserInteractionMessage(message))
      return [{ message, updates: host === message ? updates : [] }];
    if (!isStandaloneProgressAnchor(message, host, updates)) return [];
    return [{ message, updates }];
  });
}

/** Intentional progress stays separate from reasoning, activity, and final-response text. */
export function createConversationInteraction({ documentRoot = document }) {
  function createNode(updates) {
    if (updates.length === 0) return null;
    const section = documentRoot.createElement("section");
    section.className = "conversation-progress";
    section.dataset.requestId = updates[0].requestId;
    section.setAttribute("aria-label", "Progress updates");
    applyTextDirection(section, updates.map((message) => message.text).join("\n"));

    const heading = documentRoot.createElement("div");
    heading.className = "conversation-progress-heading";
    heading.textContent = "Progress updates";
    section.appendChild(heading);

    const list = documentRoot.createElement("ol");
    list.className = "conversation-progress-list";
    list.setAttribute("role", "list");
    for (const message of updates) {
      const item = documentRoot.createElement("li");
      item.className = "conversation-progress-item";
      item.dataset.messageId = message.id;
      item.dataset.requestId = message.requestId;
      const body = documentRoot.createElement("div");
      body.className = "markdown-body conversation-progress-text";
      applyTextDirection(body, message.text);
      body.innerHTML = renderMarkdown(message.text);
      item.appendChild(body);
      list.appendChild(item);
    }
    section.appendChild(list);
    return section;
  }
  return { createNode };
}
