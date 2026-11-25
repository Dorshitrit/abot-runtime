import { projectToolActivityEvent } from "../../lib/tool-activity-event.js";
import { createConversationToolEvidence } from "../conversation-tool-evidence.js";

/** Keep recorded approval evidence stable while the workspace polls. */
export function createAgentApprovalDetails({ documentRoot = document } = {}) {
  const rendered = new WeakMap();
  return function render(root, approvals = []) {
    approvals.forEach((item, index) => {
      const node = root.querySelector(`[data-agent-approval-details="${index}"]`);
      if (!node) return;
      const request = item.request || item.presentation || item;
      const activity = projectToolActivityEvent({
        eventName: "tool.approval.required",
        tool: request.call?.tool || request.tool,
        meta: request.meta,
      });
      const signature = JSON.stringify([
        item.sessionId, request.requestId,
        request.approvalId || item.approvalId || item.id,
        item.wait?.generation, item.wait?.waitId, item.wait?.revision,
        activity,
      ]);
      if (rendered.get(node) === signature) return;
      const evidence = createConversationToolEvidence(
        { ...activity, executed: false }, { documentRoot },
      );
      if (evidence) node.replaceChildren(evidence);
      else {
        const unavailable = documentRoot.createElement("p");
        unavailable.textContent = "Input details were not recorded for this approval.";
        node.replaceChildren(unavailable);
      }
      rendered.set(node, signature);
    });
  };
}
