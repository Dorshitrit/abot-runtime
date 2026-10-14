import { escapeAttribute, escapeHtml, textOf } from "../lib/text-format.js";
import { canChooseReasoning } from "../lib/reasoning-controls.js";
import { createReasoningOverridePrompt } from "../components/reasoning-override-prompt.js";

export function normalizeAgentMode(mode) {
  const normalized = textOf(mode).trim().toLowerCase();
  return ["fast", "reasoning", "deep", "auto"].includes(normalized)
    ? normalized
    : "reasoning";
}

function agentModeMeta(mode) {
  const modes = {
    auto: { label: "Auto", description: "Lets the agent choose", icon: "*" },
    fast: { label: "Low", description: "Shorter and quicker", icon: "!" },
    deep: {
      label: "Deep analysis",
      description: "More careful responses",
      icon: "D",
    },
    reasoning: {
      label: "Reasoning",
      description: "Balanced speed and thinking",
      icon: "R",
    },
  };
  return modes[normalizeAgentMode(mode)] || modes.reasoning;
}

export function createReasoningModeController({ state, dom, client, selectedEnvironmentId, selectedModelProfile, reloadModels, recordControlEvent }) {
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
    const allowed = canChooseReasoning(selectedModelProfile());
    const meta = allowed ? agentModeMeta(state.agentMode) : { label: "Provider default", icon: "—" };
    dom.agentModeButton.setAttribute("aria-haspopup", allowed ? "menu" : "dialog");
    dom.agentModeMenu.classList.toggle("reasoning-override-menu", !allowed);
    dom.agentModeButton.title = `Reasoning depth: ${meta.label}`;
    dom.agentModeButton.setAttribute("aria-label", `Reasoning depth: ${meta.label}`);
    dom.agentModeButton.disabled = agentModeMutationInFlight;
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
    dom.agentModeMenu.innerHTML = state.supportedAgentModes
      .map((mode) => {
        const item = agentModeMeta(mode);
        const selected = normalizeAgentMode(mode) === state.agentMode;
        return `
          <button class="agent-mode-option ${selected ? "selected" : ""}" type="button"
            role="menuitemradio" aria-checked="${selected ? "true" : "false"}"
            tabindex="${selected ? "0" : "-1"}" data-mode="${escapeAttribute(mode)}" ${agentModeMutationInFlight ? "disabled" : ""}>
            <span class="agent-mode-option-icon">${escapeHtml(item.icon)}</span>
            <span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.description)}</small></span>
          </button>`;
      })
      .join("");
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
    if (agentModeMutationInFlight) return false;
    if (!canChooseReasoning(selectedModelProfile())) return false;
    agentModeMutationInFlight = true;
    const environmentId = selectedEnvironmentId();
    const revision = agentModeMutationRevisionFor(environmentId) + 1;
    agentModeMutationRevisions.set(environmentId, revision);
    const loadRevisionAtStart = ++agentModeLoadRevision;
    const previousMode = state.agentMode;
    const requestedMode = normalizeAgentMode(mode);
    state.agentMode = requestedMode;
    state.agentModeMenuOpen = false;
    renderAgentMode();
    dom.agentModeButton.focus();
    try {
      const payload = await client.setAgentMode(requestedMode, environmentId);
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
      if (agentModeLoadRevision === loadRevisionAtStart) {
        state.agentMode = previousMode;
        renderAgentMode();
      }
      recordControlEvent({
        type: "control",
        name: "Reasoning mode update failed",
        tone: "failed",
        summary: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      agentModeMutationInFlight = false;
      renderAgentMode();
    }
  }

  return { renderAgentMode, loadAgentMode, setAgentMode };
}
