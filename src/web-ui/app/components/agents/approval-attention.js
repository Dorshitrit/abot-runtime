import { renderAgentBudgetAttention } from "./budget-stop.js";
import { escapeHtml as html, escapeAttribute as attr } from "../../lib/text-format.js";

export function pendingAgentApprovalTargets(agents = []) {
  const targets = new Map();
  for (const agent of agents) {
    if (agent.status === "archived" || agent.mission?.status !== "active") continue;
    for (const target of agent.approvalAttention?.targets || []) {
      const owner = agents.find(item => item.id === target.agentId);
      if (owner?.mission?.id !== target.missionId || owner.mission.status !== "active" || owner.status === "archived") continue;
      targets.set(target.agentId, target);
    }
  }
  return [...targets.values()];
}
export function renderAgentApprovalTray(agents = []) {
  return pendingAgentApprovalTargets(agents).map(target => `<div class="agents-approval-alert">
    <span><strong dir="auto">${html(target.agentName)}</strong><small>Waiting for your approval</small></span>
    <button type="button" class="agents-plain" data-agent-id="${attr(target.agentId)}">Review</button>
  </div>`).join("") + renderAgentBudgetAttention(agents);
}
export function renderDelegatedApprovalAttention(detail) {
  if (detail?.mission?.status !== "active") return "";
  const targets = (detail.approvalAttention?.targets || []).filter(target => target.agentId !== detail.agent.id);
  if (!targets.length) return "";
  const omitted = Math.max(0, (detail.approvalAttention.totalTargets || 0) - detail.approvalAttention.targets.length);
  return `<section class="agents-delegated-approval" role="status" aria-label="Delegated work needs approval">
    <strong>Delegated work needs your approval</strong>
    ${targets.map(target => `<button type="button" class="agents-plain" data-agent-id="${attr(target.agentId)}">Review <bdi dir="auto">${html(target.agentName)}</bdi></button>`).join("")}
    ${omitted ? `<small>${omitted} more agents need approval. Check the Agents space.</small>` : ""}
  </section>`;
}
