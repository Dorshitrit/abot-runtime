import { escapeAttribute, escapeHtml, textOf } from "../../lib/text-format.js";
import { validateContextWindowTokens } from "./context-window.js";
import { canEditSetupConnection } from "./connection-state.js";
import {
  validateRuntimeSetupBaseUrl,
  validateRuntimeSetupModelId,
} from "./validation.js";

export function renderProviderChoices(state) {
  const options = state.providers
    .map(
      (provider) => `<label class="runtime-provider-option">
    <input type="radio" name="runtimeSetupProvider" value="${escapeAttribute(provider.id)}" data-runtime-setup-field="provider" ${state.provider === provider.id ? "checked" : ""} />
    <span><strong>${escapeHtml(provider.label)}</strong><small>${escapeHtml(provider.description || (provider.id === "ollama" ? "A model on your computer or server" : "A hosted model using your API key"))}</small></span>
  </label>`,
    )
    .join("");
  return `<fieldset class="runtime-provider-fieldset"><legend class="sr-only">Choose a provider</legend><div class="runtime-provider-options">${options}</div></fieldset>`;
}

export function renderConnectionField({
  field,
  label,
  type = "text",
  value = "",
  placeholder = "",
  help = "",
  required = true,
  readonly = false,
  min = "",
  step = "",
  idPrefix = "runtimeSetup",
}) {
  return `<label class="runtime-setup-field"><span>${label}</span>
    <input type="${type}" data-runtime-setup-field="${field}" value="${escapeAttribute(value)}" placeholder="${escapeAttribute(placeholder)}" autocomplete="${type === "password" ? "new-password" : "off"}" spellcheck="false" ${min ? `min="${escapeAttribute(min)}"` : ""} ${step ? `step="${escapeAttribute(step)}"` : ""} ${required ? "required" : ""} ${readonly ? "readonly" : ""} aria-describedby="${idPrefix}Help-${field}" />
    <small id="${idPrefix}Help-${field}">${help}</small>
  </label>`;
}

export function renderConnectionFields(state) {
  const selectedProvider = state.providers.find(
    (provider) => provider.id === state.provider,
  );
  const credentialConfigured = selectedProvider?.credentialConfigured === true;
  const providerType = state.providerType || state.provider;
  const idPrefix = state.idPrefix || "runtimeSetup";
  const model =
    renderConnectionField({
      idPrefix,
      field: "model-id",
      label: "Model ID",
      value: state.modelId,
      placeholder: "Exact model name",
      readonly: !canEditSetupConnection(state),
      help: "Enter the model name provided by your service.",
    }) +
    renderConnectionField({
      idPrefix,
      field: "context-window",
      label: "Context window (tokens)",
      type: "number",
      value: state.contextWindowTokens,
      min: "1",
      step: "1",
      readonly: !canEditSetupConnection(state),
      help: "Use a value supported by your model. Larger windows need more memory with Ollama. You can change this later in Models.",
    });
  if (providerType === "ollama") {
    if (state.existingProvider) return model;
    return (
      model +
      renderConnectionField({
        idPrefix,
        field: "ollama-base-url",
        label: "Ollama address",
        type: "url",
        value: state.baseUrl,
        readonly: !canEditSetupConnection(state),
        placeholder: "http://127.0.0.1:11434",
        help: "Use the address reachable from the computer running ABot.",
      })
    );
  }
  if (credentialConfigured && state.allowCredentialReplacement === false)
    return model;
  return (
    model +
    renderConnectionField({
      idPrefix,
      field: "api-key",
      label: credentialConfigured ? "API key (optional)" : "API key",
      type: "password",
      required: !credentialConfigured,
      placeholder: credentialConfigured
        ? "Leave blank to keep your saved key"
        : "Enter your OpenAI API key",
      help: "Saved privately on the ABot server. Never stored in this browser.",
    })
  );
}

export function clearConnectionSecret(container) {
  const input = container.querySelector('[data-runtime-setup-field="api-key"]');
  if (input) input.value = "";
}

export function readConnectionSecret(container) {
  return textOf(
    container.querySelector('[data-runtime-setup-field="api-key"]')?.value,
  ).trim();
}

export function validateConnectionFields({
  modelId,
  contextWindowTokens,
  providerType,
  baseUrl,
  existingProvider = false,
}) {
  const model = validateRuntimeSetupModelId(modelId);
  if (!model.valid)
    return { valid: false, field: "model-id", message: model.message };
  const context = validateContextWindowTokens(contextWindowTokens);
  if (!context.valid) return context;
  const input = { model: model.value, contextWindowTokens: context.value };
  if (providerType === "ollama" && !existingProvider) {
    const address = validateRuntimeSetupBaseUrl(baseUrl);
    if (!address.valid)
      return {
        valid: false,
        field: "ollama-base-url",
        message: address.message,
      };
    input.baseUrl = address.value;
  }
  return { valid: true, input };
}

export function showConnectionFieldError(
  container,
  field,
  messageId = "runtimeSetupError",
  idPrefix = "runtimeSetup",
) {
  const input = container.querySelector(
    `[data-runtime-setup-field="${field}"]`,
  );
  input?.setAttribute?.("aria-invalid", "true");
  input?.setAttribute?.(
    "aria-describedby",
    `${idPrefix}Help-${field} ${messageId}`,
  );
  input?.focus?.();
}
