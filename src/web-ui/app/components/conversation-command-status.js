import { commandRunSummary } from "../lib/command-runs.js";

/** Command activity belongs to the conversation, without creating an assistant turn. */
export function createConversationCommandStatus({
  container,
  getCommandRun,
  isLatestWindow,
  documentRoot,
}) {
  const root = documentRoot.createElement("div");
  root.className = "conversation-command-status";
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  root.hidden = true;
  let rendered = "";
  return {
    render() {
      const record = getCommandRun();
      const wasVisible = !root.hidden;
      root.hidden = !record;
      if (root.hidden) return wasVisible;
      const nextRow = [...container.children].find(
        (node) => Number(node.dataset.createdAt) >= record.createdAt,
      );
      root.hidden = !nextRow && !isLatestWindow();
      if (root.hidden) return wasVisible;
      const moved = !container.contains(root) || root.nextSibling !== (nextRow ?? null);
      if (moved) container.insertBefore(root, nextRow ?? null);
      const identity = JSON.stringify([
        record.requestId,
        record.status,
        record.message?.error,
      ]);
      if (identity === rendered) return moved || !wasVisible;
      rendered = identity;
      root.replaceChildren();
      root.dataset.status = record.status;
      const label = documentRoot.createElement("span");
      label.textContent = commandRunSummary(record);
      root.appendChild(label);
      if (record.status !== "failed" || !record.message?.error) return true;
      const details = documentRoot.createElement("details");
      const summary = documentRoot.createElement("summary");
      summary.textContent = "Error details";
      const error = documentRoot.createElement("pre");
      error.textContent = String(record.message.error);
      details.appendChild(summary);
      details.appendChild(error);
      root.appendChild(details);
      return true;
    },
  };
}
