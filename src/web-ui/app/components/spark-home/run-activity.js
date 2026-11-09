import { createToolApprovalCard } from "../tool-approval-card.js";
import { projectToolActivityEvent } from "../../lib/tool-activity-event.js";
import { isActiveSparkHomeRun } from "../../controllers/spark-home-run-controller.js";
import { sparkHomeRunFailureMessage } from "../../lib/spark-home-run-feedback.js";

const phases = { plan: "Planning your HOME", collect: "Checking sources", followup: "Reviewing what was found",
  compose: "Building your screen", publish: "Saving your screen" };

/** A HOME status/permission view inside the existing popup, with HOME-only callbacks. */
export function createSparkHomeRunActivity({ root, onDecision, onCancel, documentRoot = root.ownerDocument }) {
  const status = documentRoot.createElement("p"); status.setAttribute("role", "status");
  const approvals = documentRoot.createElement("div");
  const cancel = documentRoot.createElement("button"); cancel.type = "button";
  cancel.className = "spark-home-action"; cancel.textContent = "Stop HOME request";
  cancel.addEventListener("click", onCancel);
  root.classList.add("spark-home-run-activity"); root.append(status, approvals, cancel);
  let approvalKey = "";
  let rejectionDraft = { text: "", expanded: false };
  return {
    render({ run, busy, connected, error }) {
      root.hidden = !run && !error;
      cancel.hidden = !isActiveSparkHomeRun(run); cancel.disabled = busy || !connected;
      if (error) status.textContent = error;
      else if (run?.status === "awaiting_approval") status.textContent = "HOME needs your approval.";
      else if (run?.status === "running") status.textContent = connected ? `${phases[run.phase] || "Creating your HOME"}…` : "Reconnecting to HOME…";
      else if (run?.status === "completed") status.textContent = "Your HOME screen is ready.";
      else if (run) status.textContent = sparkHomeRunFailureMessage(run) || "HOME stopped without replacing your screen.";
      else status.textContent = "";
      const pending = run?.status === "awaiting_approval" ? run.pendingApproval : null;
      const key = JSON.stringify([run?.runId, pending?.approvalId, busy, connected]);
      if (key === approvalKey) return;
      if (pending?.approvalId !== approvals.dataset.approvalId) rejectionDraft = { text: "", expanded: false };
      approvalKey = key; approvals.replaceChildren(); approvals.dataset.approvalId = pending?.approvalId || "";
      if (!pending) return;
      // Renderer input only: this is never emitted into ordinary chat events or session history.
      const presentation = { ...pending, name: "tool.approval.required" };
      approvals.append(createToolApprovalCard({ event: { ...pending, toolActivity: projectToolActivityEvent(presentation) },
        submitted: busy || !connected, rejectionDraft, onDecision, documentRoot }));
    },
  };
}
