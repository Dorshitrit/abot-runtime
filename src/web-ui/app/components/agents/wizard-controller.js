import { restoreAgentBudgetDraft } from "./agent-budgets.js";
import { emptyAgentDraft, agentDraftFromDetail, agentDraftAuthoring, agentDraftLimits, unchangedLongManualPrompt, validateAgentDraft, AGENT_FOCUS } from "./onboarding-options.js";

export function createAgentWizard({ client, drafts, view, getScope, getModels, getRevision, onSaved }) {
  let state = null, epoch = 0;
  const scopeMatches = (pending) => pending === state && pending.environment === getScope().environment;
  const draftKey = (id) => id ? `${id}:onboarding` : "$new";
  function budgetContext(draft) {
    const model = getModels().find(entry => entry.id === draft.modelProfileId);
    const saved = state?.definition;
    return { executionPolicy: model?.executionPolicy ?? (saved?.modelProfileId === draft.modelProfileId ? saved.executionPolicy : undefined) };
  }
  const render = () => view.wizard(state && { ...state, models: getModels(), budgetContext: budgetContext(state.draft) });
  function persist(pending) { return drafts.write(pending.environment, draftKey(pending.id), { onboarding: JSON.stringify(pending.draft) }); }

  async function refreshPreview(pending, updateView = true) {
    const request = ++epoch;
    const { draft } = pending;
    try {
      const manual = unchangedLongManualPrompt(pending.initial, draft, pending.definition);
      const authoring = agentDraftAuthoring(draft);
      if (manual) authoring.onboarding.custom = "";
      const { preview } = await client.previewAgentAuthoring({ authoring, ...(pending.id ? { targetAgentId: pending.id } : {}) }, pending.environment);
      if (!scopeMatches(pending) || request !== epoch) return false;
      pending.previewText = manual ?? preview.basePrompt;
      if (draft.budget && draft.budget !== "custom") {
        const preset = preview.presets[draft.budget];
        const previouslyShown = Object.keys(draft.limits).length > 0;
        if (previouslyShown && Object.keys(preset).some(key => Number(draft.limits[key]) !== preset[key])) draft.budget = "custom";
        else draft.limits = { ...preset };
      }
      if (pending.seedCustom && !Object.keys(draft.limits).length) draft.limits = { ...preview.presets.standard };
      pending.seedCustom = false;
      if (updateView) render();
      else { const previewNode = view.query("[data-agent-prompt-preview]"); if (previewNode) previewNode.textContent = pending.previewText; }
      return true;
    } catch (error) {
      if (scopeMatches(pending) && request === epoch) { pending.error = error.message; pending.previewText = ""; render(); }
      return false;
    }
  }
  function open(detail) {
    const scope = getScope(), id = detail?.agent.id || "";
    const saved = drafts.read(scope.environment, draftKey(id)).onboarding;
    const initial = detail ? agentDraftFromDetail(detail) : null;
    let draft = initial ? structuredClone(initial) : emptyAgentDraft();
    try { if (saved) draft = { ...draft, ...restoreAgentBudgetDraft(JSON.parse(saved)) }; } catch { /* Use the saved agent if a draft is malformed. */ }
    state = { id, environment: scope.environment, editing: Boolean(detail), initial, draft, step: detail ? 3 : 0, error: "", busy: false, definition: detail?.agent.definition };
    render(); view.query("[data-agents-wizard] button")?.focus();
    if (state.step === 3) return refreshPreview(state);
  }
  async function change(target) {
    if (!state || state.busy) return;
    const pending = state;
    if (target.name?.startsWith("limit:")) pending.draft.limits[target.name.slice(6)] = target.value;
    else if (["name", "custom", "notes"].includes(target.name)) pending.draft[target.name] = target.value;
    else return;
    const preview = pending.step === 3 && !target.name.startsWith("limit:") ? refreshPreview(pending, false) : null;
    try { await persist(pending); } catch (error) { if (scopeMatches(pending)) { pending.error = error.message; render(); } }
    await preview;
  }
  async function choose(group, value) {
    if (!state || state.busy) return;
    const pending = state, draft = pending.draft, previous = draft[group];
    if (["outputs", "asks"].includes(group)) {
      if (draft[group].includes(value)) draft[group] = draft[group].filter(id => id !== value);
      else if (group !== "outputs" || draft.outputs.length < 2) draft[group].push(value);
    } else draft[group] = value;
    if (group === "budget") {
      draft.budgetPresetVersion = 2;
      if (value !== "custom") draft.limits = {};
      pending.seedCustom = value === "custom" && !Object.keys(draft.limits).length;
    }
    if (["role", "modelProfileId"].includes(group) && previous !== value && draft.budget !== "custom") draft.limits = {};
    if (group === "role" && !draft.name) draft.name = AGENT_FOCUS[value]?.name || "";
    pending.error = "";
    if (pending.step === 3 && !await refreshPreview(pending)) return;
    try { await persist(pending); } catch (error) { if (scopeMatches(pending)) pending.error = error.message; }
    if (scopeMatches(pending)) render();
  }
  async function submit() {
    if (!state || state.busy) return;
    const pending = state;
    if (pending.step < 3) {
      pending.error = validateAgentDraft(pending.draft, pending.step, getModels());
      if (!pending.error) pending.step++;
      render();
      if (pending.step === 3) await refreshPreview(pending);
      return;
    }
    pending.busy = true; render();
    try {
      if (!await refreshPreview(pending)) { pending.busy = false; if (scopeMatches(pending)) render(); return; }
      pending.error = validateAgentDraft(pending.draft, pending.step, getModels());
      if (pending.error) { pending.busy = false; render(); return; }
      await persist(pending);
      if (!scopeMatches(pending)) return;
      const authoring = agentDraftAuthoring(pending.draft);
      const manual = unchangedLongManualPrompt(pending.initial, pending.draft, pending.definition);
      const expectedRevision = getRevision();
      const input = manual ? { expectedRevision, limits: agentDraftLimits(pending.draft), definition: {
        name: authoring.name.trim(), icon: pending.id === "abot" || pending.initial.color === pending.draft.color ? pending.definition.icon : authoring.icon,
        basePrompt: manual, modelProfileId: authoring.modelProfileId, toolPermissionMode: authoring.toolPermissionMode,
      } } : { authoring, expectedRevision };
      const result = pending.editing ? await client.updateAgent(pending.id, input, pending.environment) : await client.createAgent(input, pending.environment);
      const savedId = result.agent?.id || result.targetAgentId || result.id || pending.id;
      const closing = scopeMatches(pending);
      if (closing) { state = null; render(); }
      try { await drafts.write(pending.environment, draftKey(pending.id), {}); }
      catch { if (closing) view.error?.("Agent saved. The previous form draft could not be cleared.", false); }
      if (closing && !state && getScope().environment === pending.environment) await onSaved(savedId);
    } catch (error) {
      if (!scopeMatches(pending)) return;
      pending.busy = false;
      pending.error = (error.code || error.message) === "agents_agent_busy"
        ? "Finish or stop this agent’s open task before saving changes. Your edits are saved as a draft." : error.message;
      render();
    }
  }
  return {
    open, change, choose, submit, active: () => Boolean(state), busy: () => Boolean(state?.busy), editingId: () => state?.id || "",
    close() { if (state?.busy) return false; state = null; render(); return true; },
    reset() { state = null; render(); },
    back() { if (state && !state.busy) { state.step = Math.max(0, state.step - 1); state.error = ""; render(); } },
    refresh: render,
  };
}
