import { escapeHtml as html } from "../../lib/text-format.js";
function draftKind(scopeId) {
  if (scopeId.endsWith(":onboarding")) return "Agent setup";
  if (scopeId.endsWith(":schedule")) return "Schedule";
  if (scopeId.includes(":")) return "Task guidance";
  return "Conversation";
}
function preview(value) {
  const receipt = value.pendingId ? "An unconfirmed message receipt is retained with this draft." : "Saved draft";
  const legacyChoice = value.intent === "task" ? "Task" : value.intent === "message" ? "Conversation" : "";
  return `<pre class="agents-prompt-preview" dir="auto">${html(value.text || value.onboarding || "Empty draft")}</pre><p class="agents-hint">${receipt}${legacyChoice ? ` · ${legacyChoice}` : ""}</p>`;
}
export function createAgentDraftMigration({ drafts, view, getScope, onResolved }) {
  let state = null;
  function render() {
    if (!state) { view.migration(""); return; }
    const header = '<div class="agents-wizard-top"><span>Saved Agent drafts</span><button class="agents-close" type="button" data-migration-action="close" aria-label="Close saved drafts">×</button></div>';
    const error = `<p class="agents-error" role="alert">${html(state.error || "")}</p>`;
    if (state.collision) {
      const collision = state.collision;
      view.migration(`${header}<h1>Two drafts, both safe.</h1><p class="agents-intro">${html(draftKind(collision.id))} has a draft from before the coordinator rename and one saved afterward. Choose one to use. The other stays recoverable in Saved drafts. Nothing is sent by this choice.</p><section><strong>Saved after the rename</strong>${preview(collision.current)}<button type="button" class="agents-primary" data-migration-choice="current" ${state.busy ? "disabled" : ""}>Use this draft</button></section><section><strong>Recovered from before the rename</strong>${preview(collision.legacy)}<button type="button" class="agents-primary" data-migration-choice="legacy" ${state.busy ? "disabled" : ""}>Use this draft</button></section>${error}`); return;
    }
    view.migration(`${header}<h1>Recovered drafts.</h1><p class="agents-intro">Restoring a draft keeps the current one here, including any unconfirmed receipt. Nothing is sent.</p>${state.backups.map((backup, index) => `<section><strong>${html(draftKind(backup.scopeId))}</strong>${preview(backup.value)}<button type="button" class="agents-primary" data-migration-restore="${index}" ${state.busy ? "disabled" : ""}>Restore this draft</button></section>`).join("") || '<p class="agents-hint">No recovered drafts.</p>'}${error}`);
  }
  return {
    active: () => Boolean(state),
    conflict(error) { if (!error.collision) return; if (state?.collision?.key === error.collision.key) return; state = { ...getScope(), collision: error.collision, busy: false, error: "" }; render(); },
    open() { const scope = getScope(); state = { ...scope, backups: drafts.recovered(scope.environment, scope.selected), busy: false, error: "" }; render(); },
    close() { state = null; render(); },
    async click(target) {
      if (!state || state.busy) return;
      if (target.dataset.migrationAction === "close") { state = null; render(); return; }
      const pending = state; state.busy = true; render();
      try {
        if (target.dataset.migrationChoice) await drafts.resolveConflict(state.collision, target.dataset.migrationChoice);
        else if (target.dataset.migrationRestore !== undefined) await drafts.restoreRecovered(state.environment, state.backups[Number(target.dataset.migrationRestore)]);
        else { state.busy = false; render(); return; }
        if (state !== pending || state.environment !== getScope().environment || state.selected !== getScope().selected) return;
        state = null; render(); await onResolved();
      } catch (error) { if (state === pending) { state.busy = false; state.error = error.message; render(); } }
    },
  };
}
