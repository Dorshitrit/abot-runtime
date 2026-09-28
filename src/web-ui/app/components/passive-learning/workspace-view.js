import { agentMarkup } from "./agent-view.js";
import { learningSettingsMarkup } from "./settings-view.js";
import { learningKnowledgeMarkup } from "./knowledge-view.js";
import { learningUsageMarkup } from "./usage-view.js";
import { learningApplicationsMarkup } from "./applications-view.js";
import { computerUpdateNoticeMarkup } from "./computer-update-notice.js";
import { macCollectionRestartNoticeMarkup } from "./macos-collection-restart-notice.js";

const sections = ["insights", "activity", "applications", "settings", "usage"];
const labels = { insights: "Knowledge", activity: "Activity", applications: "Applications", settings: "Settings", usage: "Resources" };

export function learningWorkspaceMarkup(timeZone) {
  const tabs = sections.map((key, index) => `<button type="button" role="tab" id="learning-${key}-tab" data-learning-tab="${key}" aria-controls="learning-${key}-panel" aria-selected="${index === 0}" tabindex="${index === 0 ? "0" : "-1"}">${labels[key]}</button>`).join("");
  return `<section class="passive-learning-card co-worker-workspace" aria-label="ABot Spark">
    ${computerUpdateNoticeMarkup()}
    ${macCollectionRestartNoticeMarkup()}
    ${agentMarkup()}
    <div class="co-worker-quick-controls">
      <p class="passive-learning-schedule-summary" data-learning-schedule-summary></p>
      <div class="passive-learning-control-actions"><button type="button" data-learning-toggle disabled>Start collection</button><button type="button" data-learning-processing-toggle disabled>Pause processing</button><button type="button" data-learning-proactive-toggle disabled>Enable proactive mode</button></div>
    </div>
    <div class="passive-learning-attention" data-learning-attention role="status" hidden><p data-learning-attention-text></p><button type="button" data-learning-open-setup hidden>Connect computer</button></div>
    <p class="passive-learning-feedback" data-learning-feedback role="status" aria-live="polite"></p>
    <div class="co-worker-proposals" data-learning-proposals></div>
    <div class="passive-learning-tabs" role="tablist" aria-label="ABot Spark views">${tabs}</div>
    <section class="passive-learning-panel" id="learning-insights-panel" role="tabpanel" tabindex="0" aria-labelledby="learning-insights-tab" data-learning-panel="insights">${learningKnowledgeMarkup()}</section>
    <section class="passive-learning-panel" id="learning-activity-panel" role="tabpanel" tabindex="0" aria-labelledby="learning-activity-tab" data-learning-panel="activity" hidden>
      <div class="passive-learning-section-heading"><div><h4>Activity</h4><p>What was collected and how each review turned out.</p></div><button type="button" data-learning-refresh>Refresh</button></div>
      <div class="co-worker-activity-overview"><p data-learning-processing-status></p>
        <dl class="passive-learning-facts"><div><dt>Last collected</dt><dd data-learning-observation>—</dd></div><div data-learning-pending-fact><dt>Pending observations</dt><dd><span data-learning-pending>—</span><span class="co-worker-processing-badge" data-learning-processing-badge role="status" hidden>Processing now</span></dd></div><div><dt>Analysis</dt><dd data-learning-analysis>—</dd></div></dl>
        <div class="passive-learning-pending-controls"><p class="passive-learning-hint" data-learning-retention></p><button type="button" data-learning-clear-pending disabled>Delete pending…</button></div>
        <details class="passive-learning-diagnostics" data-learning-diagnostics hidden><summary>Technical details</summary><dl class="passive-learning-diagnostic-list" data-learning-reason></dl></details>
      </div>
      <div class="passive-learning-review-layout"><div class="passive-learning-detail" data-learning-detail hidden></div><section class="passive-learning-review-list" aria-label="Recent reviews"><h5>Recent reviews</h5><div class="passive-learning-batches" data-learning-batches></div></section></div>
    </section>
    <section class="passive-learning-panel" id="learning-applications-panel" role="tabpanel" tabindex="0" aria-labelledby="learning-applications-tab" data-learning-panel="applications" hidden>${learningApplicationsMarkup()}</section>
    <section class="passive-learning-panel" id="learning-settings-panel" role="tabpanel" tabindex="0" aria-labelledby="learning-settings-tab" data-learning-panel="settings" hidden>
      ${learningSettingsMarkup(timeZone)}
      <details class="passive-learning-setup" data-learning-setup><summary>Computer connection</summary>
        <dl class="passive-learning-facts co-worker-connection-facts"><div><dt>Computer</dt><dd data-learning-device>—</dd></div><div><dt>Collection access</dt><dd><span data-learning-coverage>—</span><small data-learning-coverage-detail></small></dd></div></dl>
        <p data-learning-companion-version></p><p>Collection uses the shared Computer access connection. Computer tools have their own controls.</p><button type="button" data-learning-computer-access>Manage Computer access</button></details>
    </section>
    <section class="passive-learning-panel" id="learning-usage-panel" role="tabpanel" tabindex="0" aria-labelledby="learning-usage-tab" data-learning-panel="usage" hidden>${learningUsageMarkup()}</section>
  </section>`;
}

export function selectLearningView(root, view, focus = false) {
  if (!sections.includes(view)) return;
  for (const section of sections) {
    const selected = section === view;
    const tab = root.querySelector(`[data-learning-tab="${section}"]`);
    tab.setAttribute("aria-selected", String(selected));
    tab.setAttribute("tabindex", selected ? "0" : "-1");
    root.querySelector(`[data-learning-panel="${section}"]`).hidden = !selected;
    if (selected && focus) tab.focus();
  }
}

export function navigateLearningTabs(root, event) {
  const tab = event.target.closest("[data-learning-tab]");
  if (!tab) return;
  const index = sections.indexOf(tab.dataset.learningTab);
  const destinations = { ArrowRight: (index + 1) % sections.length, ArrowLeft: (index + sections.length - 1) % sections.length, Home: 0, End: sections.length - 1 };
  if (!(event.key in destinations)) return;
  event.preventDefault();
  selectLearningView(root, sections[destinations[event.key]], true);
}
