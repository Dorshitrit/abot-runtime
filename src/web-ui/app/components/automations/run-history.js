import { escapeHtml, formatTime } from "../../lib/text-format.js";

const RUN_STATUSES = ["pending", "running", "stopping", "succeeded", "completed_with_skips", "failed", "cancelled", "interrupted", "missed"];

function renderHistoryFilters(snapshot) {
  const filters = snapshot.runsFilters || {};
  return `<form class="automation-run-filters" data-run-history-filters id="automation-run-history-filters">
    <label>Status<select name="status" id="automation-run-status-filter"><option value="">All statuses</option>${RUN_STATUSES.map((status) => `<option value="${status}"${filters.status === status ? " selected" : ""}>${escapeHtml(status.replaceAll("_", " "))}</option>`).join("")}</select></label>
    <label>Scheduled from<input type="date" name="from" id="automation-run-date-from" value="${escapeHtml(filters.from || "")}" aria-describedby="automation-run-date-help"></label>
    <label>Through<input type="date" name="to" id="automation-run-date-to" value="${escapeHtml(filters.to || "")}" aria-describedby="automation-run-date-help"></label>
    <button type="submit"${snapshot.runsLoading ? " disabled" : ""}>Apply</button>
    <button type="button" data-reset-run-history${snapshot.runsLoading ? " disabled" : ""}>Newest</button>
    <small id="automation-run-date-help">Scheduled dates in your local time.</small>
  </form>`;
}

function renderHistoryRow(run, selectedRunId) {
  const status = run.status || "unknown";
  return `<button type="button" data-select-run="${escapeHtml(run.id)}" data-run-id="${escapeHtml(run.id)}" aria-current="${run.id === selectedRunId}">
    <span class="automation-run-time">${escapeHtml(formatTime(run.scheduledAt || run.startedAt || run.createdAt) || "Run")}</span>
    <span class="automation-run-status" data-status="${escapeHtml(status)}">${escapeHtml(status.replaceAll("_", " "))}</span>
  </button>`;
}

export function renderAutomationRunHistory(snapshot) {
  const runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
  const filtered = Object.values(snapshot.runsFilters || {}).some(Boolean);
  const empty = snapshot.runsLoading ? "Loading runs…" : filtered ? "No runs match these filters." : "No runs yet.";
  const canLoadMore = snapshot.runsNextCursor || snapshot.runsError;
  return `<section class="automation-run-history" aria-labelledby="automation-run-history-heading">
    <h4 id="automation-run-history-heading">Run history <span>${runs.length} loaded</span></h4>
    ${renderHistoryFilters(snapshot)}
    ${snapshot.runsFilterError ? `<p class="automation-run-history-error" role="alert">${escapeHtml(snapshot.runsFilterError)}</p>` : ""}
    <div class="automation-run-choices" id="automation-run-history-list" aria-busy="${Boolean(snapshot.runsLoading)}">${runs.map((run) => renderHistoryRow(run, snapshot.selectedRunId)).join("") || `<p class="automation-muted">${empty}</p>`}</div>
    ${snapshot.selectedRunId && !runs.some((run) => run.id === snapshot.selectedRunId) ? `<p class="automation-muted">The selected report is outside these results and remains open below.</p>` : ""}
    <div class="automation-run-history-footer">
      <span role="status">${snapshot.runsLoading ? "Loading…" : snapshot.runsNextCursor ? "Scroll for older runs" : runs.length ? "All matching runs loaded" : ""}</span>
      ${canLoadMore ? `<button type="button" data-load-more-runs${snapshot.runsLoading ? " disabled" : ""}>${snapshot.runsError ? "Retry" : "Load more"}</button>` : ""}
    </div>
    ${snapshot.runsError ? `<p class="automation-run-history-error" role="alert">${escapeHtml(snapshot.runsError)}</p>` : ""}
  </section>`;
}

export function revealSelectedAutomationRun(root, { focus = false } = {}) {
  const list = root.querySelector("#automation-run-history-list");
  const selected = list?.querySelector('[aria-current="true"]');
  if (!selected) return;
  if (focus) selected.focus({ preventScroll: true });
  const viewport = list.getBoundingClientRect();
  const row = selected.getBoundingClientRect();
  const top = viewport.top + list.clientTop;
  const bottom = top + list.clientHeight;
  if (row.top < top) list.scrollTop += row.top - top;
  else if (row.bottom > bottom) list.scrollTop += row.bottom - bottom;
}
