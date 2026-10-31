import { buildConversationWorkTimeline } from "../../lib/conversation-work-timeline-model.js";
import { applyTextDirection, renderMarkdown } from "../../lib/text-format.js";

/** SPARK shows EA updates in the shared message style, without event chrome. */
export function createSparkChatResults({ documentRoot = document }) {
  function createNode({ requestId, updates = [] }) {
    const entries = buildConversationWorkTimeline({ requestId, updates });
    if (!entries.length) return null;
    const node = documentRoot.createElement("div");
    node.className = "spark-chat-results";
    for (const entry of entries) {
      const message = documentRoot.createElement("div");
      message.className = "markdown-body conversation-work-message";
      message.dataset.source = entry.source;
      applyTextDirection(message, entry.text);
      message.innerHTML = renderMarkdown(entry.text);
      node.appendChild(message);
    }
    return node;
  }
  return { handlesProgressUpdates: true, createNode, reset() {} };
}
