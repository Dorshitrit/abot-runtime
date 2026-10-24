import { canChooseReasoningBudget, readReasoningPreferenceField, reasoningPreferenceLabel, renderReasoningPreferenceField, syncReasoningPreferenceField } from "../lib/reasoning-preference.js";

export function createReasoningBudgetController({ state, dom, preferences, getScope, getProfile, recordControlEvent, onApplied, isModeBusy = () => false }) {
  let renderedKey;
  let saving = false;
  const isCurrentScope = (scope, profileId) => JSON.stringify(scope) === JSON.stringify(getScope()) && profileId === getProfile()?.id;
  function selectedPreference() {
    const profile = getProfile();
    const preference = preferences?.loadReasoningPreference?.(getScope(), profile?.id || "");
    if (preference && !canChooseReasoningBudget(profile))
      throw new Error("The selected model no longer supports the saved thinking budget. Choose Profile default.");
    return preference;
  }
  function syncControls() {
    const busy = saving || isModeBusy();
    dom.reasoningBudgetButton.disabled = busy;
    if (dom.agentModeButton) dom.agentModeButton.disabled = busy;
    const menu = dom.reasoningBudgetMenu;
    const save = menu.querySelector("[data-save-budget]");
    if (save) save.disabled = busy;
    const mode = menu.querySelector("[data-reasoning-preference-mode]");
    if (mode) mode.disabled = busy;
    const input = menu.querySelector("[data-reasoning-budget]");
    if (input) input.disabled = busy || mode?.value !== "budget";
  }
  function render() {
    const button = dom.reasoningBudgetButton, menu = dom.reasoningBudgetMenu;
    if (!button || !menu) return false;
    const profile = getProfile();
    const preference = preferences?.loadReasoningPreference?.(getScope(), profile?.id || "");
    const available = canChooseReasoningBudget(profile) || Boolean(preference);
    if (dom.reasoningBudgetControl) dom.reasoningBudgetControl.hidden = !available;
    button.hidden = !available;
    if (!available) { renderedKey = undefined; state.reasoningBudgetMenuOpen = false; menu.hidden = true; return false; }
    const labels = { off: "Off", "server-default": "Server default" };
    const label = preference?.mode === "budget" ? `${preference.budgetTokens} tokens` : labels[preference?.mode] || "Profile default";
    button.title = `Thinking budget: ${reasoningPreferenceLabel(preference)}`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", String(Boolean(state.reasoningBudgetMenuOpen)));
    button.textContent = label;
    button.classList.toggle("open", state.reasoningBudgetMenuOpen);
    menu.classList.toggle("open", state.reasoningBudgetMenuOpen);
    menu.hidden = !state.reasoningBudgetMenuOpen;
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "Thinking token budget");
    const nextKey = JSON.stringify([getScope(), profile?.id, canChooseReasoningBudget(profile), preference]);
    if (renderedKey === nextKey && menu.querySelector("[data-save-budget]")) { syncControls(); return true; }
    renderedKey = nextKey;
    menu.innerHTML = `${renderReasoningPreferenceField(profile, preference)}
      <button type="button" data-save-budget>Apply to next message</button>
      <p role="alert" data-budget-error hidden></p>`;
    const scope = { ...getScope() };
    menu.querySelector("[data-reasoning-preference-mode]").addEventListener("change", () => syncReasoningPreferenceField(menu, profile));
    menu.querySelector("[data-save-budget]").addEventListener("click", async () => {
      if (saving || isModeBusy()) return;
      let applied = false;
      try {
        const next = readReasoningPreferenceField(menu);
        saving = true; syncControls();
        await preferences.saveReasoningPreference(scope, profile.id, next);
        if (!isCurrentScope(scope, profile.id)) return;
        state.reasoningBudgetMenuOpen = false;
        if (onApplied) onApplied(); else render();
        applied = true;
      } catch (error) {
        if (!isCurrentScope(scope, profile.id)) return;
        const feedback = menu.querySelector("[data-budget-error]");
        feedback.textContent = error.message; feedback.hidden = false;
        recordControlEvent?.({ type: "control", name: "Thinking budget update failed", tone: "failed", summary: error.message });
      } finally {
        saving = false; syncControls();
        if (applied && isCurrentScope(scope, profile.id)) (button.hidden ? dom.agentModeButton : button)?.focus();
      }
    });
    syncControls();
    return true;
  }
  return { render, selectedPreference, isSaving: () => saving };
}
