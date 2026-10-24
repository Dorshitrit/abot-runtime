import {
  embeddingProviderOptions,
  embeddingProviderHasAddress,
  embeddingProviderAcceptsCredential,
} from "./embedding-provider-options.js";
import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";

function field(
  field,
  label,
  value = "",
  type = "text",
  help = "",
  placeholder = "",
) {
  return `<label class="runtime-setup-field"><span>${label}</span><input data-runtime-setup-field="${field}" type="${type}" value="${escapeAttribute(value)}" placeholder="${escapeAttribute(placeholder)}" autocomplete="${type === "password" ? "new-password" : "off"}" spellcheck="false" ${field === "embedding-model" ? 'list="runtimeEmbeddingModels"' : ""} />${help ? `<small>${help}</small>` : ""}</label>`;
}

function renderEmbeddingCredential(provider, providerType) {
  const credentialConfigured = provider?.credentialConfigured === true;
  let help =
    "Saved privately on the ABot server. Leave blank to keep a configured key.";
  if (providerType === "llamacpp" && !provider)
    help =
      "Optional for a server without authentication. Saved privately on the ABot server.";
  if (credentialConfigured)
    help = "API key already saved. Leave blank to use it.";
  return field(
    "embedding-key",
    providerType === "llamacpp" && !provider
      ? "API key (optional)"
      : "API key (optional if already saved)",
    "",
    "password",
    help,
    credentialConfigured ? "••••••••" : "",
  );
}

export function renderEmbeddingSetup(state, providerType, configuredProvider) {
  if (!state.loaded)
    return `<p class="runtime-setup-feedback" role="${state.error ? "alert" : "status"}">${escapeHtml(state.error || "Loading embedding options…")}</p>${state.error ? '<button type="button" class="runtime-setup-inline-action" data-runtime-setup-action="embedding-reload">Try again</button>' : ""}`;
  const providers = embeddingProviderOptions(state.providers);
  return `<div class="runtime-embedding-fields">
    ${state.status?.enabled ? '<p class="runtime-setup-feedback">Memory is already configured. You can keep it or test and save changes.</p>' : ""}
    <label class="runtime-setup-field"><span>Embedding provider</span><select data-runtime-setup-field="embedding-provider">${providers.map((provider) => `<option value="${escapeAttribute(provider.id)}" ${state.provider === provider.id ? "selected" : ""}>${escapeHtml(provider.label)}</option>`).join("")}</select></label>
    ${providerType === "llamacpp" && !configuredProvider ? field("embedding-connection-id", "Connection ID", state.newProviderId, "text", "A separate connection keeps your chat server settings unchanged.") : ""}
    ${field("embedding-model", "Embedding model ID", state.model, "text", "Choose a model that supports embeddings. ABot will not install or select one for you.")}
    <datalist id="runtimeEmbeddingModels">${state.models.map((model) => `<option value="${escapeAttribute(model)}"></option>`).join("")}</datalist>
    ${embeddingProviderAcceptsCredential(providerType, configuredProvider) ? renderEmbeddingCredential(configuredProvider, providerType) : ""}
    ${embeddingProviderHasAddress(providerType) && !configuredProvider ? field("embedding-url", providerType === "llamacpp" ? "llama.cpp address" : "Ollama address", state.baseUrl, "url", "Use the address reachable from the computer running ABot.") : ""}
    ${configuredProvider && providerType !== "llamacpp" ? '<button type="button" class="runtime-setup-inline-action" data-runtime-setup-action="embedding-discover"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg><span>Discover models</span></button>' : ""}
    <p class="runtime-setup-feedback">Test and save sends one embedding request to your provider. You can also configure this later in Settings.</p>
    ${state.error ? `<p class="runtime-setup-feedback error" role="alert">${escapeHtml(state.error)}</p>` : state.message ? `<p class="runtime-setup-feedback" role="status">${escapeHtml(state.message)}</p>` : ""}
    ${state.busy ? '<p class="runtime-setup-feedback" role="status">Checking embedding settings…</p>' : ""}
  </div>`;
}
