import { escapeHtml } from "../../lib/text-format.js";
import {
  dashboardTimePresentation,
  projectDashboardActivity,
} from "../../lib/dashboard-presentation.js";
import { dashboardIcon } from "./icons.js";

function activityTime(value) {
  const time = dashboardTimePresentation(value);
  if (!time) return "";
  return `<time class="home-row-time" datetime="${time.dateTime}" title="Scheduled ${escapeHtml(time.title)}">${escapeHtml(time.label)}</time>`;
}

function hasRecordedRunConversation(run) {
  if (!run.sessionId) return false;
  return Boolean(run.requestId);
}

function activityRow(run) {
  const action = hasRecordedRunConversation(run) ? "conversation" : "jobs";
  return `<button type="button" class="home-activity-row" data-dashboard-action="${action}" data-session-id="${escapeHtml(run.sessionId)}" data-request-id="${escapeHtml(run.requestId)}">
    <span class="home-event-icon" data-tone="${run.tone}">${dashboardIcon(run.tone)}</span>
    <span class="home-row-copy"><span class="home-row-title" dir="auto">${escapeHtml(run.title)}</span><span class="home-row-detail">${escapeHtml(run.statusLabel)}</span></span>
    ${activityTime(run.timestamp)}
  </button>`;
}

function suggestionRow(template) {
  return `<button type="button" class="home-job-suggestion" data-dashboard-action="template" data-template-id="${escapeHtml(template.id)}">
    ${dashboardIcon(template.id)}
    <span class="home-row-copy"><span class="home-row-title">${escapeHtml(template.title)}</span><span class="home-row-detail">${escapeHtml(template.timingLabel)} · ${escapeHtml(template.description)}</span></span>
    ${dashboardIcon("arrow")}
  </button>`;
}

function activityState({ loading, error, supported, templates }) {
  if (!supported)
    return '<div class="home-panel-empty"><strong>Jobs unavailable</strong><p>Choose a Runtime environment to use scheduled jobs.</p></div>';
  if (loading)
    return '<p class="home-panel-state" role="status">Loading activity…</p>';
  if (error)
    return '<div class="home-panel-state" role="alert"><p>Recent activity could not be loaded.</p><button type="button" class="home-text-button" data-dashboard-action="refresh">Try again</button></div>';
  return `<p class="home-suggestions-intro">No activity yet. Try a ready-to-use job.</p><div class="home-suggestions">${templates.map(suggestionRow).join("")}</div>`;
}

export function renderDashboardActivity({
  runs = [],
  loading = false,
  error = "",
  supported = true,
  templates = [],
}) {
  const activity = projectDashboardActivity(runs);
  const header = `<header class="home-panel-header"><h2>Recent activity</h2><button type="button" class="home-text-button" data-dashboard-action="jobs" ${supported ? "" : "disabled"}>View jobs${dashboardIcon("arrow")}</button></header>`;
  if (!activity.length)
    return header + activityState({ loading, error, supported, templates });
  const feedback = error
    ? '<p class="home-refresh-feedback" role="status">Activity could not be refreshed. <button type="button" class="home-text-button" data-dashboard-action="refresh">Try again</button></p>'
    : "";
  return `${header}<div class="home-panel-rows" aria-label="Recent job runs">${activity.map(activityRow).join("")}</div>${feedback}`;
}
