import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import { renderAgentMessages } from "./conversation.js";

function renderUpdate(update) {
  return `<article class="agents-progress" data-agent-update="${escapeAttribute(update.id)}">
    <span class="agents-progress-label">${update.sourceAgentName ? `Progress · ${escapeHtml(update.sourceAgentName)}` : "Progress"}</span><div dir="auto">${escapeHtml(update.text)}</div>
  </article>`;
}

// Keep existing message nodes attached while a poll adds a progress row or a final reply.
export function createAgentTimeline(container) {
  const rows = new Map();
  const template = container.ownerDocument.createElement("template");
  function reset() {
    rows.clear();
    container.innerHTML = '<p class="agents-chat-empty">Opening conversation…</p>';
  }
  function render(messages = [], updates = []) {
    const items = [
      ...messages.map((value) => ({ key: `message:${value.id}`, value, update: false })),
      ...updates.map((value) => ({ key: `progress:${value.id}`, value, update: true })),
    ];
    // ISO timestamps in both projections come from the server. Stable sort preserves
    // durable message order and keeps a simultaneous status after its originating message.
    items.sort((a, b) => (a.value.createdAt || "").localeCompare(b.value.createdAt || ""));
    let changed = false;
    const nearBottom = !rows.size || container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    if (!rows.size && container.firstChild) container.replaceChildren();
    const retained = new Set(items.map((item) => item.key));
    for (const [key, row] of rows) {
      if (!retained.has(key)) { changed = true; row.node.remove(); rows.delete(key); }
    }
    let cursor = container.firstChild;
    for (const { key, value, update } of items) {
      const signature = JSON.stringify([value.role, value.text ?? value.content, value.sourceAgentName]);
      let row = rows.get(key);
      if (!row || row.signature !== signature) {
        changed = true;
        template.innerHTML = update ? renderUpdate(value) : renderAgentMessages([value]);
        const node = template.content.firstElementChild;
        if (row) {
          if (cursor === row.node) cursor = node;
          row.node.replaceWith(node);
        }
        row = { node, signature };
        rows.set(key, row);
      }
      if (row.node !== cursor) { changed = true; container.insertBefore(row.node, cursor); }
      cursor = row.node.nextSibling;
    }
    if (changed && nearBottom) container.scrollTop = container.scrollHeight;
  }
  function isVisible(id) {
    const row = rows.get(`message:${id}`)?.node;
    if (!row) return false;
    const bounds = container.getBoundingClientRect(), item = row.getBoundingClientRect();
    return item.height > 0 && item.bottom > bounds.top && item.top < bounds.bottom;
  }
  return { reset, render, isVisible };
}
