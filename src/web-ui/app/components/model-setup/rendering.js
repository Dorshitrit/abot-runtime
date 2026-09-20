import { escapeHtml } from "../../lib/text-format.js";
import { formatContextWindowTokens } from "../runtime-setup/context-window.js";
import {
  renderConnectionField,
  renderConnectionFields,
  renderProviderChoices,
} from "../runtime-setup/connection-form.js";
import { renderWizardShell } from "../runtime-setup/wizard-shell.js";
import {
  modelProviderType,
  selectedModelProvider,
  requiresModelCredential,
} from "./validation.js";

export const MODEL_SETUP_STEPS = ["Provider", "Model", "Ready"];
export const MODEL_SETUP_ID = "addModelSetup";

export function modelSetupTitles(state) {
  return [
    "Choose a provider",
    "Add your model",
    state.applied
      ? "Model applied"
      : state.saved
        ? "Model saved"
        : "Review your model",
  ];
}

export function renderModelProviderChoices(state) {
  const providers = state.providers.map((provider) => ({
    id: `existing:${provider.id}`,
    label: provider.label || provider.id,
    description: `${provider.id} · ${provider.type} · existing connection`,
  }));
  providers.push(
    {
      id: "new:openai",
      label: "New OpenAI connection",
      description: "A separate connection using your API key",
    },
    {
      id: "new:ollama",
      label: "New Ollama connection",
      description: "A model on your computer or server",
    },
  );
  return renderProviderChoices({ providers, provider: state.choice });
}

export function renderModelFields(state) {
  const provider = selectedModelProvider(state);
  const credentialConfigured = !requiresModelCredential(state);
  return `${!provider ? renderConnectionField({ field: "connection-id", label: "Connection ID", value: state.newProviderId, idPrefix: MODEL_SETUP_ID, help: "A unique name for this provider connection." }) : `<p class="runtime-setup-feedback">Using ${escapeHtml(provider.label || provider.id)} · ${escapeHtml(provider.id)}</p>`}
    ${renderConnectionFields({ providers: [{ id: state.choice, credentialConfigured }], provider: state.choice, providerType: modelProviderType(state), existingProvider: Boolean(provider), allowCredentialReplacement: false, modelId: state.model, contextWindowTokens: state.contextWindowTokens, baseUrl: state.baseUrl, idPrefix: MODEL_SETUP_ID })}
    ${renderConnectionField({ field: "profile-id", label: "Model profile ID", value: state.profileId, idPrefix: MODEL_SETUP_ID, placeholder: "Suggested from the model ID", help: "A unique name for this model in ABot. Existing model defaults will stay the same." })}`;
}

export function renderModelReview(state) {
  const provider = selectedModelProvider(state);
  return `<div class="runtime-setup-result"><dl><div><dt>Connection</dt><dd>${escapeHtml(provider?.id || state.newProviderId)}</dd></div><div><dt>Model</dt><dd>${escapeHtml(state.model)}</dd></div><div><dt>Context window</dt><dd>${escapeHtml(formatContextWindowTokens(state.contextWindowTokens))}</dd></div><div><dt>Profile</dt><dd>${escapeHtml(state.profileId)}</dd></div></dl><p>${state.applied ? "Your model is applied. Refresh the model list to continue." : state.saved ? "Your model is saved. Apply it when your agent is idle." : "Save this model and apply the configuration. This does not send a model request."}</p></div>`;
}

export function modelSetupFooter(state) {
  const disabled = state.busy ? "disabled" : "";
  const back =
    state.step > 0 && !state.saved
      ? `<button type="button" class="runtime-setup-secondary" data-model-action="back" data-runtime-setup-action="model-back" ${disabled}>Back</button>`
      : "";
  const label = state.busy
    ? state.busy === "saving"
      ? "Saving…"
      : state.busy === "applying"
        ? "Applying…"
        : "Loading…"
    : state.step < 2
      ? "Continue"
      : state.applied
        ? "Refresh model list"
        : state.saved
          ? "Apply model"
          : "Save and apply";
  const action = state.step === 2 ? "finish" : "next";
  return `<div class="model-setup-back-actions"><button type="button" class="runtime-setup-secondary" data-model-action="cancel" data-runtime-setup-action="model-cancel" ${disabled}>Cancel</button>${back}</div><button type="button" class="runtime-setup-action" data-model-action="${action}" data-runtime-setup-action="model-${action}" ${state.busy || !state.loaded || !state.choice ? "disabled" : ""}>${label}</button>`;
}

export function modelSetupMarkup(state) {
  return renderWizardShell({
    steps: MODEL_SETUP_STEPS,
    step: state.step,
    title: modelSetupTitles(state)[state.step],
    form: false,
    idPrefix: MODEL_SETUP_ID,
    panelClass: "model-setup-panel",
    content:
      '<div data-model-providers></div><form data-model-form novalidate></form><div data-model-review hidden></div><p class="runtime-setup-feedback" data-model-feedback id="addModelSetupError" role="status"></p><button type="button" class="runtime-setup-inline-action" data-model-action="reload" data-runtime-setup-action="model-reload" hidden>Try again</button>',
    footer: modelSetupFooter(state),
  });
}
