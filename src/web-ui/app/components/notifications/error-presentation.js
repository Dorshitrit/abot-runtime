import { escapeHtml, escapeAttribute, formatTime } from "../../lib/text-format.js";

export function notificationErrorBadge(item) {
  if (item.severity !== "error") return "";
  const count = item.issue?.occurrenceCount;
  const repeats = Number.isSafeInteger(count) && count > 0
    ? `<span class="notification-occurrence-count" title="Occurrences">×${count}</span>` : "";
  return `<span class="notification-severity">Error</span>${repeats}`;
}

export function notificationIssueDetails(item) {
  if (!item.issue) return "";
  const outcomes = item.issue.outcomeCounts || {};
  const summary = [["recovered", "recovered"], ["failed", "failed"], ["interrupted", "interrupted"]]
    .filter(([key]) => outcomes[key] > 0)
    .map(([key, label]) => `${outcomes[key]} ${label}`).join(" · ");
  return `<div class="notification-item-meta"><span>${escapeHtml(summary)}</span>
    <span>Last occurrence: ${escapeHtml(formatTime(item.issue.lastOccurredAt))}</span></div>`;
}

export function notificationIssueAction(item, busy) {
  const kind = item.issue?.action?.kind;
  const label = kind === "step-timeout" ? "Review timeout"
    : kind === "model-settings" ? "Model settings" : "";
  if (!label) return "";
  return `<button type="button" data-notification-action="review-issue" data-notification-id="${escapeAttribute(item.id)}" ${busy ? "disabled" : ""}>${label}</button>`;
}
