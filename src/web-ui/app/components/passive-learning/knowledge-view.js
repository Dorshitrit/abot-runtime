import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import { learningTimeLabel } from "./presentation.js";

const pageSize = 20;
const views = new WeakMap();

export function learningKnowledgeMarkup() {
  return `<div class="co-worker-knowledge" data-learning-knowledge>
    <section class="co-worker-knowledge-column" aria-label="Candidates">
      <div class="co-worker-knowledge-heading"><div><h4>Candidates <span data-learning-candidate-count></span></h4>
        <p>Patterns from conversations and computer activity.</p></div><span data-learning-threshold></span></div>
      <p class="co-worker-knowledge-note" data-learning-candidate-note role="status" hidden></p>
      <div class="co-worker-knowledge-list" data-learning-candidates></div>
      <p class="co-worker-knowledge-note">Not used as memory yet. Promotion also requires two independent reinforcements. Scores are model judgments, not probabilities.</p>
      <nav class="co-worker-knowledge-pagination" data-learning-pagination aria-label="Candidate pages" hidden>
        <button type="button" data-learning-knowledge-page="previous" aria-label="Previous candidates">Previous</button>
        <span data-learning-page-summary aria-live="polite"></span>
        <button type="button" data-learning-knowledge-page="next" aria-label="Next candidates">Next</button>
      </nav>
    </section>
    <section class="co-worker-knowledge-column" aria-label="Established memory">
      <div class="co-worker-knowledge-heading"><div><h4>Established memory</h4>
        <p>Recent memories <span data-learning-saved-count></span></p></div>
        <button type="button" data-learning-memories>Manage memories</button></div>
      <div class="co-worker-knowledge-list" data-learning-saved></div>
      <p class="co-worker-knowledge-note" data-learning-history-note>Recent context from your activity. Manage memories opens the full list.</p>
    </section>
  </div>`;
}

export function renderLearningKnowledge(root, snapshot) {
  const host = root.querySelector("[data-learning-knowledge]");
  if (!host) return;
  let view = views.get(root);
  if (!view || view.host !== host || view.environmentId !== snapshot.environmentId) {
    view = { host, page: 0, environmentId: snapshot.environmentId };
    views.set(root, view);
  }
  view.snapshot = snapshot;
  renderCandidates(view);
  renderMemories(view);
}

export function handleKnowledgeClick(root, event) {
  const button = event.target.closest?.("button[data-learning-knowledge-page]");
  const view = views.get(root);
  if (!button || !view || !view.host.contains(button) || button.disabled) return false;
  const direction = button.dataset.learningKnowledgePage;
  if (direction !== "previous" && direction !== "next") return false;
  event.preventDefault();
  view.page += direction === "next" ? 1 : -1;
  renderCandidates(view);
  return true;
}

function renderCandidates(view) {
  const { host, snapshot } = view;
  const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
  view.page = Math.max(0, Math.min(view.page, Math.ceil(candidates.length / pageSize) - 1));
  const offset = view.page * pageSize;
  const threshold = boundedScore(snapshot.status?.preferences?.maturation?.promotionScore) ?? 90;
  setText(host, "[data-learning-threshold]", `Promote at ${threshold}`);
  setText(host, "[data-learning-candidate-count]", String(candidates.length));
  const note = snapshot.candidateError ? `Candidates could not be refreshed: ${snapshot.candidateError}` : "";
  setText(host, "[data-learning-candidate-note]", note);
  host.querySelector("[data-learning-candidate-note]").hidden = !note;
  const empty = snapshot.loadingCandidates ? "Loading candidates…"
    : snapshot.candidateError ? "Candidates are unavailable. Refresh to try again."
      : "No candidates yet. Useful patterns will appear here as ABot learns.";
  const markup = candidates.length ? candidates.slice(offset, offset + pageSize).map(candidateMarkup).join("")
    : `<p class="co-worker-knowledge-empty">${escapeHtml(empty)}</p>`;
  replaceList(view, "candidateMarkup", "[data-learning-candidates]", markup);
  host.querySelector("[data-learning-pagination]").hidden = candidates.length <= pageSize;
  setText(host, "[data-learning-page-summary]", candidates.length
    ? `${offset + 1}–${Math.min(offset + pageSize, candidates.length)} of ${candidates.length}` : "");
  host.querySelector('[data-learning-knowledge-page="previous"]').disabled = view.page === 0;
  host.querySelector('[data-learning-knowledge-page="next"]').disabled = offset + pageSize >= candidates.length;
}

function renderMemories(view) {
  const { snapshot, host } = view;
  const memories = Array.isArray(snapshot.status?.recentMemories) ? snapshot.status.recentMemories : [];
  setText(host, "[data-learning-saved-count]", memories.length ? String(memories.length) : "");
  const empty = !snapshot.status ? snapshot.statusError ? "Saved insights could not be loaded." : "Loading saved insights…"
    : "No recent memories learned from activity. Open Manage memories to see everything already saved.";
  const markup = memories.length ? memories.map((memory) => `<article class="co-worker-record">
    ${recordContentMarkup(memory.content)}
    <div class="co-worker-record-meta">${timeMarkup("Saved", memory.createdAt)}</div>
  </article>`).join("") : `<p class="co-worker-knowledge-empty">${escapeHtml(empty)}</p>`;
  replaceList(view, "memoryMarkup", "[data-learning-saved]", markup);
}

function candidateMarkup(candidate) {
  const score = boundedScore(candidate.score);
  const reinforcements = Array.isArray(candidate.reinforcements) ? candidate.reinforcements.length : 0;
  const evidenceMarkup = "<span>" + Math.min(2, reinforcements) + " / 2 independent reinforcements</span>";
  const dates = timeMarkup("Last reinforced", candidate.lastReinforcedAt) + timeMarkup("Expires", candidate.expiresAt);
  const scoreMarkup = score === null ? "Not scored" : `<meter min="0" max="100" value="${score}" aria-label="Model assessment: ${score} out of 100">${score}</meter><span>${score} / 100</span>`;
  return `<article class="co-worker-record" data-learning-candidate-id="${escapeAttribute(candidate.id)}">
    ${recordContentMarkup(candidate.content)}
    <div class="co-worker-record-footer"><span class="co-worker-record-score">${scoreMarkup}</span>
      ${dates || candidate.reason ? `<details class="co-worker-record-details"><summary>Why this candidate</summary>
        ${candidate.reason ? `<p class="co-worker-record-reason" dir="auto">${escapeHtml(candidate.reason)}</p>` : ""}
        <div class="co-worker-record-meta">${evidenceMarkup}${dates}</div></details>` : ""}
    </div>
  </article>`;
}

function recordContentMarkup(value) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= 240 && text.split("\n").length < 4)
    return `<p class="co-worker-record-content" dir="auto">${escapeHtml(text)}</p>`;
  return `<details class="co-worker-record-reading"><summary>
    <span class="co-worker-record-content" dir="auto">${escapeHtml(text)}</span>
    <span class="co-worker-record-read-more">Read more</span><span class="co-worker-record-read-less">Show less</span>
  </summary></details>`;
}

function boundedScore(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : null;
}

function timeMarkup(label, value) {
  if (!Number.isFinite(Date.parse(value || ""))) return "";
  return `<span>${label} <time datetime="${escapeAttribute(value)}">${escapeHtml(learningTimeLabel(value))}</time></span>`;
}

function setText(root, selector, value) {
  const element = root.querySelector(selector);
  if (element.textContent !== value) element.textContent = value;
}

function replaceList(view, key, selector, markup) {
  if (view[key] === markup) return;
  view[key] = markup;
  view.host.querySelector(selector).innerHTML = markup;
}
