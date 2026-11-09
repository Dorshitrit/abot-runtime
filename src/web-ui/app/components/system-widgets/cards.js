import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import { basketStatusLabel } from "../../lib/information-basket-presentation.js";
import { candidateActionsMarkup } from "../passive-learning/candidate-actions.js";
import { DASHBOARD_SYSTEM_WIDGET_HEIGHTS } from "./dashboard-mounts.js";
import { SYSTEM_METRICS_HEIGHT } from "./metrics-card.js";

export const SYSTEM_WIDGET_HEIGHTS = Object.freeze({ "memory-candidates": 360, skills: 400, resources: 400, "feature-discovery": 240,
  "system-metrics": SYSTEM_METRICS_HEIGHT,
  ...DASHBOARD_SYSTEM_WIDGET_HEIGHTS });
// The catalog may grow independently of the existing per-screen instance bound.
export const SYSTEM_WIDGET_LIMIT = 10;
const titles = { "memory-candidates": "Memory candidates", skills: "Your Skills", resources: "Your Resources", "feature-discovery": "Discover ABot" };
const action = (name, label, id = "") => `<button type="button" data-widget-action="${name}" data-widget-item="${escapeAttribute(id)}">${escapeHtml(label)}</button>`;

function sourceNotice(source) {
  if (source?.supported === false) return '<p class="system-widget-note">Unavailable in this environment.</p>';
  if (source?.error) return `<p class="system-widget-note" role="alert">${escapeHtml(source.error)}</p>${action("refresh", "Try again")}`;
  if (!source?.data) return '<p class="system-widget-note" role="status">Loading…</p>';
  return "";
}
function memoryMarkup(state, page) {
  const notice = sourceNotice(state.sources.candidates);
  if (notice) return notice;
  const items = state.candidates || [];
  const offset = Math.min(page, Math.max(0, Math.ceil(items.length / 5) - 1)) * 5;
  const rows = items.slice(offset, offset + 5).map(candidate => `<li><p dir="auto">${escapeHtml(candidate.content)}</p>
    ${candidate.replacement ? '<small>Suggested update to an existing memory</small>' : ""}
    ${candidateActionsMarkup(candidate, state.pendingCandidateId)}</li>`).join("");
  return `${state.candidateActionError ? `<p role="alert" class="system-widget-note">${escapeHtml(state.candidateActionError)}</p>` : ""}
    ${rows ? `<ul class="system-widget-list">${rows}</ul>` : '<p class="system-widget-note">No candidates waiting for your review.</p>'}
    ${items.length > 5 ? `<footer>${action("previous", "Previous")}<span>${offset + 1}–${Math.min(items.length, offset + 5)} of ${items.length}</span>${action("next", "Next")}</footer>` : ""}`;
}
function skillMarkup(source) {
  const notice = sourceNotice(source);
  if (notice) return notice;
  const items = source.data.items.filter(item => item.source === "personal" && !item.archived);
  return `<p class="system-widget-note">Reusable guidance for how ABot works with you.</p>
    <ul class="system-widget-list">${items.slice(0, 4).map(item => `<li>${action("skill", item.name, item.skillId)}<small dir="auto">${escapeHtml(item.description)}</small></li>`).join("")}</ul>
    ${!items.length ? '<p class="system-widget-note">Create your first personal Skill.</p>' : ""}
    <footer><span>${items.length} active</span>${action("skills", "Manage Skills")}</footer>`;
}
function resourceMarkup(source) {
  const notice = sourceNotice(source);
  if (notice) return notice;
  const items = source.data.sources || [];
  return `<p class="system-widget-note">Your files, available across conversations.</p>
    <ul class="system-widget-list">${items.slice(0, 4).map(item => `<li>${action("resource", item.displayName, item.sourceId)}<small>${escapeHtml(basketStatusLabel(item.status))}</small></li>`).join("")}</ul>
    ${!items.length ? '<p class="system-widget-note">Add sources to give ABot useful context.</p>' : ""}
    <footer><span>${items.length} sources</span>${action("resources", "Manage Resources")}</footer>`;
}

/** Suggestions require known live state; missing reads never mean a feature is inactive. */
function currentWidgetSourceData(source) {
  if (!source || source.supported === false || source.loading || source.error) return undefined;
  return source.data;
}
export function systemFeatureSuggestions(sources) {
  const result = [];
  const skills = currentWidgetSourceData(sources.skills)?.items;
  if (Array.isArray(skills) && !skills.some(item => item.source === "personal" && !item.archived))
    result.push({ action: "skills", title: "Make ABot work your way", detail: "Create a personal Skill with your preferred workflow." });
  const resources = currentWidgetSourceData(sources.resources);
  if (resources?.settings?.enabled === false || resources?.sources?.length === 0)
    result.push({ action: "resources", title: "Bring your sources", detail: "Link files and choose how they become searchable." });
  const permissions = currentWidgetSourceData(sources.learning)?.status?.preferences?.activityPermissions;
  if (permissions?.learning === false || permissions?.proactive === false)
    result.push({ action: "spark-settings", title: "Explore SPARK", detail: "Review learning and proactive options. You choose what to enable." });
  return result;
}
function discoveryMarkup(sources) {
  const suggestions = systemFeatureSuggestions(sources);
  if (suggestions.length) return `<ul class="system-widget-list">${suggestions.map(item => `<li>${action(item.action, item.title)}<small>${escapeHtml(item.detail)}</small></li>`).join("")}</ul>`;
  if ([sources.learning, sources.skills, sources.resources].some(source => source?.loading || !source)) return '<p class="system-widget-note">Checking available features…</p>';
  return "";
}
export function renderSystemWidget(id, state, page = 0) {
  let content;
  if (id === "memory-candidates") content = memoryMarkup(state, page);
  else if (id === "skills") content = skillMarkup(state.sources.skills);
  else if (id === "resources") content = resourceMarkup(state.sources.resources);
  else if (id === "feature-discovery") content = discoveryMarkup(state.sources);
  else return "";
  if (!content) return "";
  return `<section class="system-widget-card" aria-label="${titles[id]}"><header><div><span class="system-widget-origin">ABot</span><h3>${titles[id]}</h3></div>${action("refresh", "Refresh")}</header><div class="system-widget-content">${content}</div></section>`;
}
