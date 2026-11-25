import { escapeHtml as html, escapeAttribute as attr } from "../../lib/text-format.js";

export function renderAgentBudgetStop(detail) {
  const recovery = detail?.recovery;
  if (!["agents_token_limit_reached", "agents_model_call_limit_reached"].includes(recovery?.budgetStopReason)) return "";
  const stopping = recovery.budgetStopping === true;
  const label = recovery.budgetStopReason === "agents_token_limit_reached" ? "Token limit reached" : "Model call limit reached";
  const session = recovery.budgetSessionId && detail.sessions?.some(item => item.sessionId === recovery.budgetSessionId)
    ? `<button type="button" class="agents-plain" data-agent-session="${attr(recovery.budgetSessionId)}">View saved work</button>` : "";
  return `<section class="agents-paused-task agents-budget-stop" aria-label="Task budget status">
    <div role="status"><small>System</small><strong>${label}</strong>
      <p>${stopping ? "Stopping the work session and waiting for its final status." : "The task ended at its budget limit. Any saved work remains available in its sessions."}</p></div>
    ${session ? `<div class="agents-pause-actions">${session}</div>` : ""}
  </section>`;
}

/** Kept outside the chat so a delegated stop stays visible while its parent is open. */
export function renderAgentBudgetAttention(agents = []) {
  return agents.filter(agent => agent.status !== "archived" && !agent.isDeleting && agent.budgetStop?.missionId === agent.mission?.id &&
    ["awaiting_user_decision", "exhausted"].includes(agent.mission?.status) &&
    ["agents_token_limit_reached", "agents_model_call_limit_reached"].includes(agent.budgetStop?.reason)).map(agent => {
      const label = agent.budgetStop.reason === "agents_token_limit_reached" ? "Token limit reached" : "Model call limit reached";
      return `<div class="agents-approval-alert agents-budget-alert"><span><strong dir="auto">${html(agent.definition?.name || agent.name || "Agent")}</strong>
        <small>System · ${label}${agent.budgetStop.stopping ? " · Stopping" : ""}</small></span>
        <button type="button" class="agents-plain" data-agent-id="${attr(agent.id)}">View task</button></div>`;
    }).join("");
}
