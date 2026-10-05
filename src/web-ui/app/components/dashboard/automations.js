import { escapeHtml } from "../../lib/text-format.js";

function runLink(automation, environmentId) {
  const query = new URLSearchParams({
    environment: environmentId,
    automation: automation.id,
    run: automation.latestRunId,
  });
  return `/automations?${query}`;
}

function runStatusLabel(status) {
  return { pending: "Queued", stopping: "Stopping" }[status] || "Running";
}

export function renderDashboardAutomations(automations = [], environmentId = "", unavailable = false) {
  if (!automations.length && !unavailable) return "";
  const visible = automations.slice(0, 3);
  const remaining = automations.length - visible.length;
  const heading = unavailable ? "Automation status unavailable" :
    `${automations.length} ${automations.length === 1 ? "automation" : "automations"} in progress`;
  return `<div class="home-automation-heading"><span>ABot Studio</span><strong>${heading}</strong></div>
    <div class="home-automation-runs">${visible.map((automation) => `<a class="home-automation-run" href="${escapeHtml(runLink(automation, environmentId))}">
      ${unavailable ? "" : '<span class="home-automation-pulse" aria-hidden="true"></span>'}
      <strong dir="auto">${escapeHtml(automation.title || "ABot Automation")}</strong>
      <span>${unavailable ? "Last seen " : ""}${runStatusLabel(automation.latestRunStatus)} · ${unavailable ? "Open run" : "View live timeline"}</span>
    </a>`).join("")}${remaining ? `<span class="home-automation-more">+${remaining} more in ABot Studio</span>` : ""}${unavailable ? '<button type="button" class="home-automation-retry" data-dashboard-action="refresh">Retry</button>' : ""}</div>`;
}
