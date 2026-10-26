import { escapeHtml } from "../../lib/text-format.js";
import { basketIcon } from "../information-basket/icons.js";
import { dashboardIcon } from "./icons.js";

export function hasDashboardResourceAttention(snapshot = {}) {
  if (snapshot.supported === false) return false;
  if (snapshot.issues?.length) return true;
  return Boolean(snapshot.error || snapshot.mutationError);
}

function resourcesCountLabel(count) {
  return `${count} ${count === 1 ? "source needs" : "sources need"} attention`;
}

function areResourceActionsDisabled(snapshot) {
  if (snapshot.loading) return true;
  if (snapshot.mutation) return true;
  return Boolean(snapshot.error);
}

function resourceRow(issue, disabled) {
  return `<li class="home-resource-issue">
    <span class="home-resource-file-icon">${basketIcon("file")}</span>
    <div class="home-resource-copy"><strong class="home-resource-name" dir="auto" title="${escapeHtml(issue.displayName)}">${escapeHtml(issue.displayName)}</strong>
      <span class="home-resource-reason">${escapeHtml(issue.title)}</span>
      <p class="home-resource-detail">${escapeHtml(issue.detail)}</p></div>
    <button type="button" class="home-resource-action" data-dashboard-resource-action="${escapeHtml(issue.action)}"
      data-source-id="${escapeHtml(issue.sourceId)}" data-source-revision="${escapeHtml(issue.revision)}"
      aria-label="${escapeHtml(`${issue.label}: ${issue.displayName}`)}"${disabled ? " disabled" : ""}>${escapeHtml(issue.label)}</button>
  </li>`;
}

function resourceFeedback({ error, mutationError, message, mutation, loading }) {
  const rows = [];
  if (error) rows.push(`<div class="home-resource-feedback is-error" role="alert"><span>Resources could not be refreshed. ${escapeHtml(error)}</span>
    <button type="button" class="home-text-button" data-dashboard-resource-action="refresh"${loading || mutation ? " disabled" : ""}>Retry</button></div>`);
  if (mutationError) rows.push(`<p class="home-resource-feedback is-error" role="alert">${escapeHtml(mutationError)}</p>`);
  if (message) rows.push(`<p class="home-resource-feedback" role="status">${escapeHtml(message)}</p>`);
  if (mutation) rows.push('<p class="home-resource-feedback" role="status">Updating resource…</p>');
  if (loading && !mutation) rows.push('<p class="home-resource-feedback" role="status">Refreshing Resources…</p>');
  return rows.join("");
}

/** Existing detected problems only; interaction and freshness remain owned by the controller. */
export function renderDashboardResources({ issues = [], error = "", mutation = "", mutationError = "", message = "", loading = false } = {}) {
  const snapshot = { issues, error, mutation, mutationError, message, loading };
  const visible = issues.slice(0, 3);
  const count = issues.length;
  const heading = count ? "Resources need attention" : "Resources";
  const countBadge = count ? `<span class="home-resources-count" aria-label="${resourcesCountLabel(count)}">${count}</span>` : "";
  const footer = count > 3 ? `Showing 3 of ${count} sources` : resourcesCountLabel(count);
  return `<section class="home-resources-attention" aria-label="Resources attention" aria-busy="${Boolean(loading || mutation)}">
    <header class="home-resources-heading"><span class="home-resources-alert-icon">${dashboardIcon("failed")}</span>
      <h2>${heading}</h2>${countBadge}</header>
    ${resourceFeedback(snapshot)}
    ${count ? `<ul class="home-resource-issues">${visible.map(issue => resourceRow(issue, areResourceActionsDisabled(snapshot))).join("")}</ul>` : ""}
    <footer class="home-resources-footer"><span>${count ? footer : "Manage your connected sources"}</span>
      <button type="button" class="home-text-button" data-dashboard-resource-action="resources">View all Resources ${dashboardIcon("arrow")}</button></footer>
  </section>`;
}

/** Matches the existing Home widget-card preview contract. */
export function dashboardResourcesSummary(resourceAttention = {}) {
  const { issues = [], error = "", mutationError = "", message = "", loading = false } = resourceAttention;
  const count = issues.length;
  const title = count ? resourcesCountLabel(count) : "Resources";
  if (error)
    return { count, title, detail: "Last known status. Resources could not be refreshed.", status: "Needs attention", tone: "attention" };
  const preview = count ? { kind: "rows", badge: { value: count, label: resourcesCountLabel(count), tone: "attention" },
    items: issues.slice(0, 2).map(issue => ({ title: issue.displayName, detail: issue.title,
      indicator: { icon: "failed", label: issue.title, tone: "attention" } })) } : undefined;
  if (mutationError)
    return { count, title, detail: "Open Resources to review the latest status.", status: "Needs attention", tone: "attention", preview };
  if (loading)
    return { count, title, detail: "Refreshing Resources…", status: "Refreshing", tone: "neutral", preview };
  return { count, title, detail: message || "Review source updates and indexing issues.",
    status: count ? "Needs attention" : "View Resources", tone: count ? "attention" : "neutral", preview };
}
