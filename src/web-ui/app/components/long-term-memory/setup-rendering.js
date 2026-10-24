import { escapeAttribute, escapeHtml, textOf } from "../../lib/text-format.js";
import { renderSavedEmbeddingProfiles, selectedEmbeddingProfile } from "./saved-embedding-profiles.js";

export function renderMemorySetup({ state, selectedProvider, selectedModel, canSave, canRemove, canAddConnection, emitClientEvents }) {
  const status = state.status || {};
  const providers = Array.isArray(status.providers) ? status.providers : [];
  const enabled = status.enabled === true;
  const profile = selectedEmbeddingProfile(state);
  const savedSelection = canSave && Boolean(profile);
  const fieldsDisabled = state.busy || savedSelection ? "disabled" : "";
  const busy = state.busy ? "disabled" : "";
  const activation = canSave && !profile ? "" : `<button type="button" class="primary-button" data-memory-action="enable" ${busy}>${state.busy === "enable" ? "Testing connection…" : "Test &amp; enable memory"}</button>`;
  return `<section class="memory-setup-card" aria-busy="${Boolean(state.busy)}">
    <div class="memory-setup-heading">
      <div><p class="eyebrow">passive memory</p><h4>Long-term memory</h4>
        <p>Choose the embedding model used to find relevant memories across conversations.</p></div>
      <span class="memory-status ${enabled ? "enabled" : "disabled"}">${enabled ? "Enabled" : "Disabled"}</span>
    </div>
    ${canSave ? renderSavedEmbeddingProfiles(state, canRemove) : ""}
    <section class="embedding-profile-editor" aria-label="${savedSelection ? "Selected profile" : "New embedding profile"}">
      <div class="embedding-editor-heading"><h5>${savedSelection ? "Selected profile" : "New embedding profile"}</h5>
        <p>${savedSelection ? "Test the connection and save this profile as the memory configuration. Apply the configuration separately to use it." : "Save a reusable profile first. Saving does not enable memory or contact the provider."}</p>
      </div>
      <div class="memory-setup-fields">
        ${canSave ? `<label class="embedding-profile-name"><span>Profile name</span><input data-memory-profile-label value="${escapeAttribute(state.profileLabel)}" placeholder="For example: Qwen · local server" ${fieldsDisabled} /></label>` : ""}
        <label><span>Connection</span><select data-memory-provider ${fieldsDisabled}>${providerOptions(providers, selectedProvider)}</select></label>
        <label><span>Embedding model</span><input data-memory-model list="memoryEmbeddingModels" value="${escapeAttribute(selectedModel)}" placeholder="For example: text-embedding-3-small" ${fieldsDisabled} />
          <datalist id="memoryEmbeddingModels">${state.models.map((model) => `<option value="${escapeAttribute(textOf(model))}"></option>`).join("")}</datalist></label>
        ${savedSelection || !canSave ? `<label class="memory-events-toggle"><input data-memory-events type="checkbox" ${emitClientEvents ? "checked" : ""} ${busy} /><span>Show memory activity in conversations</span></label>` : ""}
      </div>
      <div class="memory-setup-actions">
        ${!savedSelection && canSave ? `<button type="button" class="primary-button" data-memory-action="save-profile" ${busy}>${state.busy === "save-profile" ? "Saving…" : "Save profile"}</button>` : ""}
        ${activation}
        ${!savedSelection ? `<button type="button" data-memory-action="discover" ${busy}>Discover models</button>` : ""}
        ${canAddConnection ? `<button type="button" data-memory-action="add-connection" ${busy}>Add connection</button>` : ""}
        ${enabled ? `<button type="button" data-memory-action="disable" ${busy}>Disable memory</button>` : ""}
      </div>
    </section>
    ${feedbackMarkup(state)}
  </section>`;
}

function providerOptions(providers, selectedProvider) {
  const options = providers.map((provider) => `<option value="${escapeAttribute(provider.id)}" ${provider.id === selectedProvider ? "selected" : ""}>${escapeHtml(provider.id)} · ${escapeHtml(provider.type)}</option>`);
  if (!providers.some((provider) => provider.id === selectedProvider)) {
    options.unshift(`<option value="${escapeAttribute(selectedProvider)}" selected>${escapeHtml(selectedProvider || "Choose a connection")}${selectedProvider ? " (unavailable)" : ""}</option>`);
  }
  return options.join("");
}

function feedbackMarkup(state) {
  if (state.error) return `<p class="memory-setup-feedback error-text" role="alert">${escapeHtml(state.error)}</p>`;
  if (state.message) return `<p class="memory-setup-feedback" role="status">${escapeHtml(state.message)}</p>`;
  return "";
}
