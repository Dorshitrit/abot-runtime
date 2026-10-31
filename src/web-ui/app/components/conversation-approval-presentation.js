import { applyTextDirection, renderMarkdown } from "../lib/text-format.js";

/** A saved approval is progress presentation, never a copyable final answer. */
export function createConversationApprovalPresentation({
  message, activity, thinking, progress, status, statusPlacement, documentRoot,
}) {
  const row = documentRoot.createElement("article");
  row.className = "message-row assistant message-approval-presentation";
  row.dataset.messageId = String(message.id);
  row.dataset.requestId = message.requestId || "";
  row.setAttribute("aria-label", "Tool approval");
  const bubble = documentRoot.createElement("div");
  bubble.className = "message-bubble";
  const label = documentRoot.createElement("div");
  label.className = "message-meta";
  label.textContent = "Tool approval";
  bubble.appendChild(label);
  if (activity) bubble.appendChild(activity);
  if (thinking) bubble.appendChild(thinking);
  if (progress) bubble.appendChild(progress);
  if (message.text) {
    const intent = documentRoot.createElement("div");
    intent.className = "markdown-body conversation-approval-intent";
    applyTextDirection(intent, message.text);
    intent.innerHTML = renderMarkdown(message.text);
    bubble.appendChild(intent);
  }
  if (status && statusPlacement !== "outside") bubble.appendChild(status);
  row.appendChild(bubble);
  if (status && statusPlacement === "outside") {
    row.classList.add("message-status-outside");
    row.appendChild(status);
  }
  return row;
}
