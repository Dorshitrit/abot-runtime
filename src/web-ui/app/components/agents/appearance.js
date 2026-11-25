import { escapeHtml, escapeAttribute } from "../../lib/text-format.js";
import { AGENT_COLORS } from "./onboarding-options.js";
export function agentColor(agent) {
  if (agent.id === "abot") return "#91efde";
  return AGENT_COLORS[String(agent.definition?.icon || "").replace("pebbles-", "")] || AGENT_COLORS.blue;
}
export function agentPortrait(agent) {
  return '<span class="agents-eyes" aria-hidden="true"><span></span><span></span></span>';
}
export function agentStatusLabel(agent) {
  const status = agent.status === "archived" ? "archived" : agent.workStatus || agent.activityStatus || agent.status;
  return ({ active: "Ready when you are", idle: "Ready when you are", thinking: "Thinking", working: "Working in the background", awaiting_approval: "Waiting for your approval", awaiting_user_decision: "Waiting for your decision", failed: "Needs attention", archived: "Archived" })[status] || "Ready when you are";
}
export function agentIsWorking(agent) {
  if (!agent.hasWork || agent.mission?.status !== "active") return false;
  const status = agent.workStatus || agent.activityStatus || agent.status;
  return status === "working" || status === "thinking";
}
export function renderAgentButton(agent, index) {
  return `<button class="agents-orbit-agent${agentIsWorking(agent) ? " is-working" : ""}${agent.workStatus === "awaiting_approval" ? " needs-approval" : ""}" type="button" data-agent-id="${escapeAttribute(agent.id)}" aria-label="${escapeAttribute(agent.definition.name)} — ${escapeAttribute(agentStatusLabel(agent))}" aria-pressed="false" style="--agent-color:${agentColor(agent)};--blink-delay:-${index * 1.3}s;--blink-period:${6.8 + index * .9}s"><span class="agents-orb-shell"><span class="agents-work-ring" aria-hidden="true"></span><span class="agents-orb">${agentPortrait(agent)}</span></span><span class="agents-name">${escapeHtml(agent.definition.name)}</span></button>`;
}
export function agentHoverWork(agent) {
  if (agent.mission?.status !== "active") return null;
  if (agent.workStatus === "awaiting_approval") return { label: "Waiting for approval", text: "" };
  if (!agentIsWorking(agent)) return null;
  const objective = agent.mission.objective?.trim();
  if (!objective || objective === agent.latestAgentMessage) return null;
  return { label: "Working on", text: objective };
}
