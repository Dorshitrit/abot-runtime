import { escapeHtml, formatTime } from "../../lib/text-format.js";

function isAutomationDraft(item) {
  return !item.publishedRevision;
}

function automationStatus(item) {
  if (item.status === "archived") return "Archived";
  if (isAutomationDraft(item)) return "Draft";
  if (item.status === "active") return "Active";
  return "Paused";
}

function automationUpdatedTime(item) {
  const timestamp = Date.parse(item.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function renderAutomationRows(entries) {
  return `<div class="automation-list" aria-label="Automations">${entries.map((item) => {
    const status = automationStatus(item);
    const updatedAt = formatTime(item.updatedAt) || "—";
    return `<button type="button" class="automation-list-item" data-select-automation="${escapeHtml(item.id)}"><strong dir="auto">${escapeHtml(item.title || "ABot Automation")}</strong><span class="automation-list-state" data-state="${status.toLowerCase()}">${status}</span><small>Last edited ${escapeHtml(updatedAt)}<br>Draft ${escapeHtml(item.draftRevision || 0)} · Published ${escapeHtml(item.publishedRevision || "—")}</small><small>${item.latestRunId ? "Open to see the latest run" : "No runs yet"}</small></button>`;
  }).join("")}</div>`;
}

function renderAutomationGroup(entries, name, title) {
  if (!entries.length) return "";
  return `<section class="automation-list-group" data-automation-list-group="${name}" aria-labelledby="automation-${name}-title">
    <h4 id="automation-${name}-title">${title} <span>${entries.length}</span></h4>
    ${renderAutomationRows(entries)}
  </section>`;
}

function renderAutomationEntries(entries, archived) {
  if (!entries.length) return `<div class="automation-empty">${archived ? "No archived automations." : "Describe what you want to automate in a chat, or build the steps manually. You can start with a tool or an agent."}</div>`;
  if (archived) return renderAutomationRows(entries);
  const published = entries.filter((item) => !isAutomationDraft(item));
  const drafts = entries.filter(isAutomationDraft);
  return renderAutomationGroup(published, "published", "Published")
    + renderAutomationGroup(drafts, "drafts", "Drafts");
}

export function renderAutomationList(snapshot, { archived = false } = {}) {
  const all = Array.isArray(snapshot.automations) ? snapshot.automations : [];
  const entries = all.filter((item) => (item.status === "archived") === archived)
    .sort((left, right) => automationUpdatedTime(right) - automationUpdatedTime(left));
  const archivedCount = all.filter((item) => item.status === "archived").length;
  return `<div class="automation-workspace">
    <section class="automation-list-panel" aria-labelledby="automation-list-title">
    <div class="automation-heading"><div><span class="automation-kicker">ABot Studio</span><h3 id="automation-list-title">Automations</h3><p>Build a sequence of tools and agents. Runs finish with a saved report.</p></div>
      <div class="automation-actions"><button type="button" data-action="refresh">Refresh</button><button type="button" data-action="create">Build manually</button><button type="button" class="automation-primary" data-action="describe">Describe your automation</button></div></div>
    <p class="automation-feedback" role="status" aria-live="polite" data-tone="${snapshot.error ? "error" : ""}">${escapeHtml(snapshot.error || (snapshot.loading ? "Loading automations…" : `${entries.length} ${entries.length === 1 ? "automation" : "automations"}`))}</p>
    <div class="automation-list-filters" role="group" aria-label="Automation status"><button type="button" data-automation-list-filter="current" aria-pressed="${!archived}">Current</button><button type="button" data-automation-list-filter="archived" aria-pressed="${archived}">Archived${archivedCount ? ` · ${archivedCount}` : ""}</button></div>
    ${renderAutomationEntries(entries, archived)}
    </section>
  </div>`;
}
