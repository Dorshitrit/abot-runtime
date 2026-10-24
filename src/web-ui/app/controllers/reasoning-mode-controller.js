import { escapeHtml, textOf } from "../lib/text-format.js";
import { agentModeMeta, canChooseReasoning, renderReasoningModeButtons } from "../lib/reasoning-controls.js";
import { createReasoningBudgetController } from "./reasoning-budget-controller.js";
import { createReasoningOverridePrompt } from "../components/reasoning-override-prompt.js";

export function normalizeAgentMode(mode) {
  const normalized = textOf(mode).trim().toLowerCase();
  return ["fast", "reasoning", "deep", "auto"].includes(normalized)
    ? normalized
    : "reasoning";
}

export function createReasoningModeController({ state, dom, client, selectedEnvironmentId, selectedModelProfile, reloadModels, recordControlEvent, preferences, getScope }) {
  const budget = createReasoningBudgetController({ state, dom, preferences, getScope, getProfile: selectedModelProfile, recordControlEvent, onApplied: () => renderAgentMode(), isModeBusy: () => agentModeMutationInFlight });
  let agentModeError = "";
  let modeErrorScope;
  let agentModeLoadRevision = 0;
  const agentModeMutationRevisions = new Map();
  let agentModeMutationInFlight = false;
  const agentModeMutationRevisionFor = (environmentId) =>
    agentModeMutationRevisions.get(environmentId) || 0;
  const prompt = createReasoningOverridePrompt({
    root: dom.agentModeMenu, client, getEnvironmentId: selectedEnvironmentId,
    getProfile: selectedModelProfile, refreshModels: reloadModels,
    render: () => renderAgentMode(),
  });
  function renderAgentMode() {
    budget.render();
    const allowed = canChooseReasoning(selectedModelProfile());
    const meta = allowed ? agentModeMeta(state.agentMode) : { label: "Provider default", icon: "—" };
    dom.agentModeButton.setAttribute("aria-haspopup", allowed ? "menu" : "dialog");
    dom.agentModeMenu.classList.toggle("reasoning-override-menu", !allowed);
    dom.agentModeButton.title = `Reasoning depth: ${meta.label}`;
    dom.agentModeButton.setAttribute("aria-label", `Reasoning depth: ${meta.label}`);
    dom.agentModeButton.disabled = agentModeMutationInFlight || budget.isSaving();
    dom.agentModeButton.innerHTML = `
      <span class="agent-mode-icon">${escapeHtml(meta.icon)}</span>
      <span>${escapeHtml(meta.label)}</span>`;
    dom.agentModeButton.classList.toggle("open", state.agentModeMenuOpen);
    dom.agentModeButton.setAttribute(
      "aria-expanded",
      state.agentModeMenuOpen ? "true" : "false",
    );
    dom.agentModeMenu.classList.toggle("open", state.agentModeMenuOpen);
    dom.agentModeMenu.hidden = !state.agentModeMenuOpen;
    dom.agentModeMenu.setAttribute("role", allowed ? "menu" : "dialog");
    dom.agentModeMenu.setAttribute("aria-label", allowed ? "Reasoning depth" : "Enable reasoning controls");
    if (!allowed) { prompt.render(state.agentModeMenuOpen); return; }
    const restoreFocus = Boolean(dom.agentModeMenu.contains?.(dom.agentModeMenu.ownerDocument?.activeElement));
    prompt.reset();
    const thinkingOff = preferences?.loadReasoningPreference?.(getScope(), selectedModelProfile()?.id || "")?.mode === "off";
    const modeError = modeErrorScope === JSON.stringify([getScope?.(), selectedModelProfile()?.id]) ? agentModeError : "";
    dom.agentModeMenu.innerHTML = renderReasoningModeButtons(state.agentMode, state.supportedAgentModes, agentModeMutationInFlight || budget.isSaving())
      + `<small class="reasoning-mode-default-note">${thinkingOff ? "Thinking is Off. Choosing a mode turns it back on. " : ""}Sets the default depth; model profile and calibration settings may override it. Token budgets are set separately.</small>
        <p role="alert" data-mode-error${modeError ? "" : " hidden"}>${escapeHtml(modeError)}</p>`;
    dom.agentModeMenu
      .querySelectorAll(".agent-mode-option")
      .forEach((button) => {
        button.addEventListener(
          "click",
          () => void setAgentMode(button.dataset.mode),
        );
      });
    if (restoreFocus && state.agentModeMenuOpen)
      dom.agentModeMenu.querySelector?.('[tabindex="0"]')?.focus();
  }

  async function loadAgentMode() {
    const revision = ++agentModeLoadRevision;
    const environmentId = selectedEnvironmentId();
    const mutationRevision = agentModeMutationRevisionFor(environmentId);
    renderAgentMode();
    try {
      const payload = await client.getAgentMode(environmentId);
      if (
        revision !== agentModeLoadRevision ||
        mutationRevision !== agentModeMutationRevisionFor(environmentId) ||
        environmentId !== selectedEnvironmentId()
      ) {
        return false;
      }
      state.agentMode = normalizeAgentMode(payload.mode);
      state.supportedAgentModes = Array.isArray(payload.supportedModes)
        ? payload.supportedModes.map(normalizeAgentMode)
        : state.supportedAgentModes;
      renderAgentMode();
      return true;
    } catch {
      if (
        revision !== agentModeLoadRevision ||
        mutationRevision !== agentModeMutationRevisionFor(environmentId) ||
        environmentId !== selectedEnvironmentId()
      ) {
        return false;
      }
      state.agentMode = "reasoning";
      renderAgentMode();
      return false;
    }
  }

  async function setAgentMode(mode) {
    if (agentModeMutationInFlight || budget.isSaving()) return false;
    if (!canChooseReasoning(selectedModelProfile())) return false;
    agentModeMutationInFlight = true;
    agentModeError = "";
    const scope = getScope ? { ...getScope() } : undefined;
    const profileId = selectedModelProfile()?.id || "";
    const manualOverride = scope && preferences?.loadReasoningPreference?.(scope, profileId);
    let modeSaved = false;
    const environmentId = selectedEnvironmentId();
    const isOriginatingSelection = () => environmentId === selectedEnvironmentId()
      && profileId === selectedModelProfile()?.id
      && (!scope || JSON.stringify(scope) === JSON.stringify(getScope()));
    const revision = agentModeMutationRevisionFor(environmentId) + 1;
    agentModeMutationRevisions.set(environmentId, revision);
    const loadRevisionAtStart = ++agentModeLoadRevision;
    const previousMode = state.agentMode;
    const requestedMode = normalizeAgentMode(mode);
    state.agentMode = requestedMode;
    state.agentModeMenuOpen = false;
    renderAgentMode();
    try {
      const payload = await client.setAgentMode(requestedMode, environmentId);
      modeSaved = true;
      if (environmentId === selectedEnvironmentId()) state.agentMode = normalizeAgentMode(payload.mode);
      if (manualOverride?.mode === "off") await preferences.saveReasoningPreference(scope, profileId, undefined);
      if (
        revision !== agentModeMutationRevisionFor(environmentId) ||
        environmentId !== selectedEnvironmentId()
      ) {
        return false;
      }
      agentModeLoadRevision += 1;
      state.agentMode = normalizeAgentMode(payload.mode);
      renderAgentMode();
      return true;
    } catch (error) {
      if (
        revision !== agentModeMutationRevisionFor(environmentId) ||
        environmentId !== selectedEnvironmentId()
      ) {
        return false;
      }
      if (!modeSaved && agentModeLoadRevision === loadRevisionAtStart) {
        state.agentMode = previousMode;
        renderAgentMode();
      }
      modeErrorScope = JSON.stringify([scope, profileId]);
      agentModeError = modeSaved
        ? "The reasoning mode was saved, but Thinking Off could not be cleared. " + (error instanceof Error ? error.message : String(error))
        : (error instanceof Error ? error.message : String(error));
      if (isOriginatingSelection()) state.agentModeMenuOpen = true;
      recordControlEvent({
        type: "control",
        name: "Reasoning mode update failed",
        tone: "failed",
        summary: agentModeError,
      });
      return false;
    } finally {
      agentModeMutationInFlight = false;
      renderAgentMode();
      if (isOriginatingSelection() && !state.agentModeMenuOpen) dom.agentModeButton.focus();
    }
  }

  return { renderAgentMode, loadAgentMode, setAgentMode, selectedReasoningPreference: budget.selectedPreference };
}
