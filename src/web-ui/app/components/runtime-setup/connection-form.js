import { renderSetupPromptCacheField, setupPromptCacheInput } from "./prompt-cache-fields.js";
import { renderChatgptLogo } from "../chatgpt-accounts/sign-in-button.js";
import { renderConnectionInspection } from "./connection-inspection.js";
import { renderSetupReasoningFields, validateSetupReasoningFields } from "./reasoning-fields.js";
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
    ${["openai-chatgpt", "new:openai-chatgpt"].includes(provider.id) ? `<span class="chatgpt-provider-logo">${renderChatgptLogo()}</span>` : ""}
    <span><strong>${escapeHtml(provider.label)}</strong><small>${escapeHtml(provider.description || (provider.id !== "openai" ? "A model on your computer or server" : "A hosted model using your API key"))}</small></span>
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
  error = "",
  required = true,
  readonly = false,
  min = "",
  step = "",
  idPrefix = "runtimeSetup",
}) {
  return `<label class="runtime-setup-field"><span>${label}</span>
    <input type="${type}" data-runtime-setup-field="${field}" value="${escapeAttribute(value)}" placeholder="${escapeAttribute(placeholder)}" autocomplete="${type === "password" ? "new-password" : "off"}" spellcheck="false" ${min ? `min="${escapeAttribute(min)}"` : ""} ${step ? `step="${escapeAttribute(step)}"` : ""} ${required ? "required" : ""} ${readonly ? "readonly" : ""} ${error ? 'aria-invalid="true"' : ""} aria-describedby="${idPrefix}Help-${field}${error ? ` ${idPrefix}Error-${field}` : ""}" />
    <small id="${idPrefix}Help-${field}">${help}</small>
    ${error ? `<small id="${idPrefix}Error-${field}" class="runtime-setup-feedback error" role="alert">${escapeHtml(error)}</small>` : ""}
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
      help: providerType === "ollama"
        ? "Use Discover models to check installed names. Saving settings does not verify that this model is installed."
        : "Enter the model name provided by your service.",
    }) +
    renderConnectionField({
      idPrefix,
      field: "context-window",
      label: "Context window (tokens)",
      type: "number",
      value: state.contextWindowTokens,
      min: state.contextWindowFeedback?.minimumTokens || "1",
      error: state.contextWindowFeedback?.message,
      step: "1",
      readonly: !canEditSetupConnection(state),
      help: "Use a value supported by your model. Larger windows need more memory on local servers. You can change this later in Models.",
    });
  const reasoning = renderSetupReasoningFields(state, !canEditSetupConnection(state)) + renderSetupPromptCacheField(state, !canEditSetupConnection(state));
  if (providerType === "openai-chatgpt") return '<div data-chatgpt-connection></div>' + model + reasoning;
  if (providerType === "llamacpp") {
    const address = state.existingProvider ? "" : renderConnectionField({
      idPrefix, field: "llamacpp-base-url", label: "llama.cpp address", type: "url",
      value: state.baseUrl, readonly: !canEditSetupConnection(state),
      placeholder: "http://127.0.0.1:8080",
      help: "Start llama-server separately. Use the origin reachable from the computer running ABot.",
    });
    const preservesExistingNoKeyConnection = state.existingProvider && selectedProvider?.requiresApiKey !== true;
    const keepsConfiguredCredential = credentialConfigured && state.allowCredentialReplacement === false;
    const key = preservesExistingNoKeyConnection || keepsConfiguredCredential ? "" : renderConnectionField({
      idPrefix, field: "api-key", label: "API key (if your server requires one)", type: "password",
      required: selectedProvider?.requiresApiKey === true && !credentialConfigured,
      placeholder: credentialConfigured ? "Leave blank to keep your saved key" : "Optional server API key",
      help: "Saved privately on the ABot server. Leave empty for a server without authentication.",
    });
    return model + address + key + renderConnectionInspection(state) + reasoning;
  }
  if (providerType === "ollama") {
    if (state.existingProvider) return model + renderConnectionInspection(state) + reasoning;
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
      }) + renderConnectionInspection(state) + reasoning
    );
  }
  if (credentialConfigured && state.allowCredentialReplacement === false)
    return model + reasoning;
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
    }) + reasoning
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
  supportsThinking, reasoningBudgetMode, reasoningBudgetTokens, promptCache,
}) {
  const model = validateRuntimeSetupModelId(modelId);
  if (!model.valid)
    return { valid: false, field: "model-id", message: model.message };
  const context = validateContextWindowTokens(contextWindowTokens);
  if (!context.valid) return context;
  const input = { model: model.value, contextWindowTokens: context.value };
  if (["ollama", "llamacpp"].includes(providerType) && !existingProvider) {
    const address = validateRuntimeSetupBaseUrl(baseUrl);
    if (!address.valid)
      return {
        valid: false,
        field: providerType + "-base-url",
        message: address.message,
      };
    input.baseUrl = address.value;
  }
  const reasoning = validateSetupReasoningFields({ providerType, supportsThinking, reasoningBudgetMode, reasoningBudgetTokens });
  if (!reasoning.valid) return reasoning;
  return { valid: true, input: { ...input, ...reasoning.input, ...setupPromptCacheInput(providerType, promptCache) } };
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
