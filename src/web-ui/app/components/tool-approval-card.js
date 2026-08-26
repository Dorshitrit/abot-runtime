import { formatToolName } from "../lib/event-presentation.js";
import { textOf } from "../lib/text-format.js";

export function createToolApprovalCard({
  event,
  submitted = false,
  onDecision,
  documentRoot = document,
}) {
  const approvalId = textOf(event?.approvalId);
  const row = documentRoot.createElement("article");
  row.className = "message-row assistant approval-message-row";

  const bubble = documentRoot.createElement("div");
  bubble.className = "message-bubble approval-message-bubble";

  const toolLabel =
    formatToolName(event?.tool) || textOf(event?.name) || "Tool";
  row.setAttribute("aria-label", `${toolLabel} permission request`);

  const header = documentRoot.createElement("div");
  header.className = "approval-message-header";
  const label = documentRoot.createElement("span");
  label.className = "approval-message-label";
  label.textContent = "Approval required";
  const title = documentRoot.createElement("strong");
  title.className = "approval-message-title";
  title.textContent = `Allow ${toolLabel} to run?`;
  header.append(label, title);

  const detail = documentRoot.createElement("p");
  detail.className = "approval-message-detail";
  detail.dir = "auto";
  detail.textContent =
    textOf(event?.summary) || "The runtime is waiting for your decision.";
  bubble.append(header, detail);

  const actions = documentRoot.createElement("div");
  actions.className = "tool-approval-actions";
  actions.setAttribute("aria-label", "Permission request actions");
  const approveButton = documentRoot.createElement("button");
  approveButton.className = "tool-approval-button approve";
  approveButton.type = "button";
  approveButton.textContent = "Approve";
  approveButton.disabled = submitted;
  approveButton.addEventListener("click", () => onDecision(approvalId, true));
  const rejectButton = documentRoot.createElement("button");
  rejectButton.className = "tool-approval-button reject";
  rejectButton.type = "button";
  rejectButton.textContent = "Reject";
  rejectButton.disabled = submitted;
  rejectButton.addEventListener("click", () => onDecision(approvalId, false));
  actions.append(approveButton, rejectButton);
  bubble.appendChild(actions);

  row.appendChild(bubble);
  return row;
}
