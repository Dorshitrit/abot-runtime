import { isLegacyCoordinatorDraftConflict } from "./legacy-coordinator-drafts.js";
import { renderAgentSchedules } from "./schedule-view.js";
import { AGENT_BUDGETS, agentDraftLimits } from "./onboarding-options.js";
import { agentBudgetContext, createAgentBudgetSelection, invalidAgentBudget, restoreAgentBudgetDraft } from "./agent-budgets.js";
const intervals = { once: null, hourly: 3600000, daily: 86400000 };
function localDate(value) { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function nextStart(form) {
  if (form.originalStartAt && Number.isFinite(Date.parse(form.originalStartAt)) && localDate(form.originalStartAt) === form.startAt) return form.originalStartAt;
  return form.startAt;
}
function intervalFor(form) {
  if (form.editing && form.frequency === "existing" && Number.isSafeInteger(form.originalIntervalMs)) return form.originalIntervalMs;
  return Object.hasOwn(intervals, form.frequency) ? intervals[form.frequency] : undefined;
}
export function validateAgentScheduleForm(form, now = Date.now()) {
  if (!form.title.trim() || !form.text.trim()) return "Add a title and the task to run.";
  const start = Date.parse(nextStart(form));
  if (!Number.isFinite(start) || start <= now) return "Choose a future start time.";
  if (intervalFor(form) === undefined) return "Choose how often to run.";
  const count = form.frequency === "once" ? 1 : Number(form.maxOccurrences);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) return "Choose 1–1,000 total occurrences.";
  if (!AGENT_BUDGETS[form.budget]) return "Choose a budget for each occurrence.";
  if (invalidAgentBudget(form)) return "Enter whole numbers for all five budget limits.";
  return "";
}
export function createAgentSchedules({ client, drafts, view, getScope, viewport = window }) {
  let state = null;
  const selection = createAgentBudgetSelection(client);
  const current = (scope) => scope.environment === getScope().environment && scope.selected === getScope().selected;
  const render = () => view.schedules(state ? renderAgentSchedules(state) : "");
  async function persist() { if (state?.form) await drafts.write(state.environment, `${state.selected}:schedule`, { onboarding: JSON.stringify(state.form) }); }
  async function list() {
    if (!state) return; selection.reset(); const pending = state; state.form = null; state.loading = true; render();
    try { const result = await client.listAgentSchedules(pending.selected, pending.environment); if (pending !== state || !current(pending)) return; state.records = result.schedules; state.error = ""; }
    catch (error) { if (pending === state && current(pending)) state.error = error.message; }
    if (pending === state && current(pending)) { state.loading = false; render(); }
  }
  function begin(record) {
    if (!state) return;
    selection.reset(); state.error = "";
    state.form = { id: viewport.crypto.randomUUID(), title: "", text: "", startAt: "", frequency: "once", maxOccurrences: 1, budget: "", limits: {} };
    if (!record) {
      try { const saved = drafts.read(state.environment, `${state.selected}:schedule`).onboarding; if (saved) state.form = { ...state.form, ...restoreAgentBudgetDraft(JSON.parse(saved)) }; } catch (error) { if (isLegacyCoordinatorDraftConflict(error)) throw error; /* Keep an empty form if an old draft is malformed. */ }
      render(); return;
    }
    const originalStartAt = record.nextRunAt || record.startAt;
    const frequency = Object.keys(intervals).find(key => intervals[key] === record.intervalMs) || "existing";
    state.form = { id: record.id, editing: true, expectedRevision: record.revision, title: record.title, text: record.text,
      startAt: localDate(originalStartAt), originalStartAt, originalIntervalMs: record.intervalMs, frequency,
      maxOccurrences: record.maxOccurrences, budget: "custom", limits: { ...record.limits } }; render();
  }
  async function save() {
    const active = state, currentForm = active?.form;
    if (!currentForm || active.saving || !await selection.settled()) return;
    if (active !== state || currentForm !== state.form || active.saving) return;
    state.error = validateAgentScheduleForm(state.form); if (state.error) { render(); return; }
    const pending = state, form = state.form; state.saving = true; render();
    try {
      await persist();
      const input = { title: form.title.trim(), text: form.text.trim(), startAt: new Date(nextStart(form)).toISOString(), intervalMs: intervalFor(form), maxOccurrences: form.frequency === "once" ? 1 : Number(form.maxOccurrences), limits: agentDraftLimits(form) };
      if (form.editing) await client.updateAgentSchedule(pending.selected, form.id, { ...input, expectedRevision: form.expectedRevision }, pending.environment);
      else await client.createAgentSchedule(pending.selected, { ...input, id: form.id }, pending.environment);
      await drafts.write(pending.environment, `${pending.selected}:schedule`, {});
      if (state !== pending || !current(pending)) return;
      state.saving = false; await list();
    } catch (error) { if (state === pending && current(pending)) { state.saving = false; state.error = `${error.message} Your schedule draft is kept.`; render(); } }
  }
  return {
    async open(detail) { state = { ...getScope(), agentName: detail.agent.definition.name, budgetContext: agentBudgetContext(detail.agent.definition), records: [], form: null, error: "", loading: true, saving: false }; await list(); },
    close() { selection.reset(); state = null; render(); }, active: () => Boolean(state), save,
    async change(target) { if (!state?.form || state.saving) return; if (target.name.startsWith("schedule:")) state.form[target.name.slice(9)] = target.value; if (target.name.startsWith("limit:")) state.form.limits[target.name.slice(6)] = target.value; await persist(); },
    async click(target) {
      if (!state || state.saving) return;
      if (target.dataset.scheduleBudget) {
        const pending = state;
        const applied = await selection.choose(pending.form, target.dataset.scheduleBudget, pending, persist, error => { pending.error = error.message; render(); });
        if (applied && pending === state) { pending.error = ""; render(); }
        return;
      }
      if (target.dataset.scheduleFrequency) { state.form.frequency = target.dataset.scheduleFrequency; await persist(); render(); return; }
      if (target.dataset.scheduleEdit) { begin(state.records.find((record) => record.id === target.dataset.scheduleEdit)); return; }
      if (target.dataset.scheduleCancel) { const record = state.records.find((entry) => entry.id === target.dataset.scheduleCancel); if (!record) return; const pending = state; await client.cancelAgentSchedule(state.selected, record.id, { expectedRevision: record.revision }, state.environment); if (pending === state && current(pending)) await list(); return; }
      if (target.dataset.scheduleAction === "new") begin();
      if (target.dataset.scheduleAction === "list") await list();
      if (target.dataset.scheduleAction === "close") { selection.reset(); state = null; render(); }
    },
  };
}
