import { escapeHtml } from "../../lib/text-format.js";
import { formatContextWindowTokens } from "./context-window.js";
import {
  canEditSetupConnection,
  setupConnectionSubmitLabel,
} from "./connection-state.js";
import {
  renderProviderChoices,
  renderConnectionFields,
} from "./connection-form.js";
import { renderWizardShell } from "./wizard-shell.js";

const STEP_LABELS = ["Provider", "Connection", "Embedding", "Plugins", "Ready"];

function readyMarkup(state, optional) {
  const applied = state.finishAttempted && state.activation?.status === "ready";
  const message = applied
    ? "Your setup is applied. Continue to your first conversation."
    : state.finishAttempted
      ? state.activation?.message ||
        "Your settings are saved. Try again when your agent is idle."
      : "Apply your choices to start your first conversation.";
  const selectedPlugins = (optional.plugins?.plugins || []).filter(
    (plugin) => plugin.pluginEnabled,
  ).length;
  return `<div class="runtime-setup-result"><p>${escapeHtml(message)}</p><dl>
    <div><dt>Provider</dt><dd>${escapeHtml(state.providers.find((provider) => provider.id === state.provider)?.label || state.provider)}</dd></div>
    <div><dt>Model</dt><dd>${escapeHtml(state.modelId)}</dd></div>
    <div><dt>Context window</dt><dd>${escapeHtml(formatContextWindowTokens(state.contextWindowTokens))}</dd></div>
    <div><dt>Embedding</dt><dd>${escapeHtml(optional.memory?.enabled ? optional.memory.model || "Configured" : "Set up later")}</dd></div>
    <div><dt>Plugins</dt><dd>${selectedPlugins} enabled</dd></div>
  </dl></div>`;
}

function statusMarkup(state, availability) {
  if (state.error)
    return `<p class="runtime-setup-feedback error" id="runtimeSetupError" role="alert">${escapeHtml(state.error)}</p>`;
  if (state.loading)
    return '<p class="runtime-setup-feedback" role="status">Loading connection options…</p>';
  if (state.applying)
    return '<p class="runtime-setup-feedback" role="status">Applying your connection…</p>';
  if (state.saving)
    return '<p class="runtime-setup-feedback" role="status">Saving your connection…</p>';
  if (availability.status === "checking")
    return '<p class="runtime-setup-feedback" role="status">Checking the model catalog…</p>';
  if (availability.status === "error")
    return `<p class="runtime-setup-feedback error" role="alert">Could not check the model catalog. ${escapeHtml(availability.message || "Try again.")}</p>`;
  return "";
}

function footerMarkup(state, availability, optional) {
  const busy =
    state.loading ||
    state.saving ||
    state.applying ||
    optional.busy ||
    availability.status === "checking";
  const disabled = busy ? "disabled" : "";
  if (state.step === (optional.readyStep ?? 4)) {
    const action =
      state.finishAttempted && state.activation?.status === "ready"
        ? "check"
        : "apply";
    const label = state.applying
      ? "Applying…"
      : action === "check"
        ? "Start chatting"
        : state.finishAttempted
          ? "Try again"
          : "Finish setup";
    const back =
      action === "check"
        ? "<span></span>"
        : `<button type="button" class="runtime-setup-secondary" data-runtime-setup-action="back" ${disabled}>Back</button>`;
    return `${back}<button type="button" class="runtime-setup-action" data-runtime-setup-action="${action}" ${disabled}>${label}</button>`;
  }
  if (state.step === 2)
    return `<button type="button" class="runtime-setup-secondary" data-runtime-setup-action="back" ${disabled}>Back</button><div class="runtime-setup-footer-actions"><button type="button" class="runtime-setup-secondary" data-runtime-setup-action="skip-embedding" ${disabled}>Skip for now</button><button type="submit" class="runtime-setup-action" ${busy || !optional.canContinue ? "disabled" : ""}>${optional.busy ? "Checking…" : optional.primaryLabel}</button></div>`;
  if (state.step === 3)
    return `<button type="button" class="runtime-setup-secondary" data-runtime-setup-action="back" ${disabled}>Back</button><button type="submit" class="runtime-setup-action" ${busy || !optional.canContinue ? "disabled" : ""}>Continue</button>`;
  if (state.step === 4 && optional.hasComputerStep)
    return `<button type="button" class="runtime-setup-secondary" data-runtime-setup-action="back">Back</button><div class="runtime-setup-footer-actions"><button type="button" class="runtime-setup-secondary" data-runtime-setup-action="skip-computer">Skip for now</button><button type="submit" class="runtime-setup-action" ${!optional.canContinue ? "disabled" : ""}>Continue</button></div>`;
  const secondary =
    state.step === 1 && canEditSetupConnection(state)
      ? `<button type="button" class="runtime-setup-secondary" data-runtime-setup-action="back" ${disabled}>Back</button>`
      : `<button type="button" class="runtime-setup-secondary" data-runtime-setup-action="check" ${disabled}>${availability.status === "checking" ? "Checking…" : "Check existing setup"}</button>`;
  if (state.loadFailed)
    return `${secondary}<button type="button" class="runtime-setup-action" data-runtime-setup-action="reload" ${disabled}>Try again</button>`;
  const nextDisabled = busy || (state.step === 0 && !state.provider);
  return `${secondary}<button type="submit" class="runtime-setup-action" ${nextDisabled ? "disabled" : ""}>${state.saving ? "Saving…" : state.step === 0 ? "Continue" : setupConnectionSubmitLabel(state)}</button>`;
}

export function renderRuntimeSetup(state, availability, optional = {}) {
  const titles = [
    "Connect your first model",
    "Connection details",
    "Add embedding",
    "Choose your plugins",
    state.finishAttempted && state.activation?.status === "ready"
      ? "You're ready"
      : "Ready to finish",
  ];
  const descriptions = [
    "Choose where your model runs.",
    state.provider === "ollama"
      ? "Connect ABot to your Ollama server."
      : "Connect ABot to your OpenAI account.",
    "Optional. Enable long-term memory with an embedding model, or set it up later.",
    "Choose what your agent can use. You can change these choices later in Settings.",
    "",
  ];
  const steps = [...STEP_LABELS];
  if (optional.hasComputerStep) {
    steps.splice(4, 0, "Computer");
    titles.splice(4, 0, "Set up computer access");
    descriptions.splice(
      4,
      0,
      "Optional. Use applications on your computer, or set up access later in Settings.",
    );
  }
  const content =
    state.step === 0
      ? renderProviderChoices(state)
      : state.step === 1
        ? renderConnectionFields(state)
        : state.step === (optional.readyStep ?? 4)
          ? readyMarkup(state, optional)
          : optional.content;
  const busy = state.loading || state.saving || state.applying || optional.busy;
  return renderWizardShell({
    steps,
    step: state.step,
    title: titles[state.step],
    description: descriptions[state.step],
    busy,
    panelClass: state.step === 3 ? "runtime-setup-panel--plugins" : "",
    content: `${content}${statusMarkup(state, availability)}`,
    footer: footerMarkup(state, availability, optional),
  });
}
