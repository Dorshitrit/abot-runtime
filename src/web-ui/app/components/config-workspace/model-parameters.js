import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import { modelParameterInputValidationError, readModelParameterInputDraft } from "./model-parameter-input-drafts.js";

const sourceLabels = {
  manual: "Manual", configuration: "Saved config", profile: "Model profile",
  provider: "Provider/runtime default", server: "Server default",
};

export function modelParameterPresentation(state, file, generationPath) {
  const metadata = state.configDashboard?.modelParameters?.[file.id];
  const presentation = generationPath[0] === "calibration" ? metadata?.calibration?.[generationPath[1]] : metadata?.model;
  for (const field of presentation?.parameters ?? []) {
    const draft = readModelParameterInputDraft(file.config, generationPath, field.key);
    delete field.editingText;
    delete field.editingError;
    if (draft) Object.assign(field, { editingText: draft.text, editingError: draft.error });
  }
  return presentation;
}

function fieldAttributes(file, generationPath, field) {
  return `data-kind="model" data-id="${escapeAttribute(file.id)}" data-generation-path="${escapeAttribute(JSON.stringify(generationPath))}" data-parameter-key="${escapeAttribute(field.key)}"`;
}

function controlMode(field) {
  if (field.editingText !== undefined) return "value";
  if (field.editingValue) return "value";
  if (field.control) return field.control.mode;
  return field.explicit ? "value" : "legacy";
}

function fieldValue(field) {
  if (field.editingText !== undefined) return field.editingText;
  if (field.editingValue) return "";
  if (field.control?.mode === "value") return field.control.value;
  if (field.control) return "";
  return field.explicit ? field.configuredValue ?? field.value ?? "" : "";
}

function renderValueInput(file, generationPath, field) {
  const attributes = `${fieldAttributes(file, generationPath, field)} data-config-action="model-parameter-value" aria-label="${escapeAttribute(field.label)} value"${field.editingError ? ' aria-invalid="true"' : ""}`;
  const value = fieldValue(field);
  const placeholder = field.recommended === undefined ? "" : `Recommended: ${field.recommended}`;
  if (field.type === "enum" || field.type === "bool") {
    const values = field.values ?? [false, true];
    const unknown = value !== "" && !values.some((item) => String(item) === String(value));
    return `<select ${attributes}><option value="">Not sent</option>${unknown ? `<option value="${escapeAttribute(value)}" selected disabled>Saved: ${escapeHtml(value)}</option>` : ""}${values.map((item) => `<option value="${escapeAttribute(item)}" ${String(value) === String(item) ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select>`;
  }
  return `<input type="number" ${attributes} value="${escapeAttribute(value)}" placeholder="${escapeAttribute(placeholder)}" ${field.min !== undefined ? `min="${escapeAttribute(field.min)}"` : ""} ${field.max !== undefined ? `max="${escapeAttribute(field.max)}"` : ""} step="${escapeAttribute(field.step ?? (field.type === "int" ? 1 : "any"))}">`;
}

function renderParameterField(file, generationPath, field) {
  const mode = controlMode(field);
  return `<div class="config-model-parameter" role="group" aria-label="${escapeAttribute(field.label)}">
    <div class="config-model-parameter-header"><span class="config-model-parameter-name">${escapeHtml(field.label)}</span>
      <span class="config-model-parameter-source" title="${escapeAttribute(sourceLabels[field.source] ?? field.source)}">${escapeHtml(sourceLabels[field.source] ?? field.source)}</span>
      <details class="config-model-parameter-info"><summary aria-label="About ${escapeAttribute(field.label)}">i</summary>
        <div class="config-model-parameter-help"><p>${escapeHtml(field.description)}</p>${field.note ? `<p>${escapeHtml(field.note)}</p>` : ""}</div>
      </details>
    </div>
    <div class="config-model-parameter-inputs">
    <select ${fieldAttributes(file, generationPath, field)} data-config-action="model-parameter-mode" aria-label="${escapeAttribute(field.label)} mode">
      ${mode === "legacy" ? '<option value="legacy" selected>Existing</option>' : ""}
      <option value="omit" ${mode === "omit" ? "selected" : ""}>Not sent</option>
      <option value="inherit" ${mode === "inherit" ? "selected" : ""}>Inherit</option>
      <option value="value" ${mode === "value" ? "selected" : ""}>Custom</option>
    </select>${renderValueInput(file, generationPath, field)}</div>
    ${field.editingError ? `<p class="config-model-parameter-warning" role="alert">${escapeHtml(field.editingError)}</p>` : ""}
    ${field.warnings.map((warning) => `<p class="config-model-parameter-warning" role="status">${escapeHtml(warning.message)}</p>`).join("")}
  </div>`;
}

function renderParameterGroup(title, fields, extra = "") {
  if (!fields && !extra) return "";
  return `<section class="config-model-parameter-group" aria-label="${escapeAttribute(title)}">
    <h4>${escapeHtml(title)}</h4><div class="config-model-parameter-grid">${fields}${extra}</div>
  </section>`;
}

export function renderModelParameters(file, generationPath, presentation, { reasoningFields = "", advancedFields = "" } = {}) {
  if (!presentation) return "";
  const supported = presentation.parameters.filter((field) => field.supported && field.modelSupport !== "unsupported");
  const hasRecommendations = supported.some((field) => field.recommended !== undefined);
  const standard = supported.filter((field) => !field.advanced);
  const advanced = supported.filter((field) => field.advanced);
  const renderFields = (fields) => fields.map((field) => renderParameterField(file, generationPath, field)).join("");
  const sampling = renderFields(standard.filter((field) => field.group !== "reasoning"));
  const reasoning = renderFields(standard.filter((field) => field.group === "reasoning"));
  const overviewWarnings = presentation.warnings.filter((warning) => !warning.key || !supported.some((field) => field.key === warning.key));
  const hasUnknownModelSupport = supported.some((field) => field.modelSupport === "unknown");
  const recommendationsDisabled = presentation.pending || presentation.stale || modelParameterInputValidationError(file.config);
  return `<div class="config-model-parameters" aria-busy="${presentation.pending === true}">
    <div class="config-model-parameter-toolbar">
      ${hasRecommendations ? `<button type="button" data-config-action="model-parameters-recommended" data-kind="model" data-id="${escapeAttribute(file.id)}" data-generation-path="${escapeAttribute(JSON.stringify(generationPath))}" ${recommendationsDisabled ? "disabled" : ""}>Apply recommended</button>` : ""}
      ${presentation.notes ? `<details class="config-model-parameter-notes"><summary>Model notes</summary><p>${escapeHtml(presentation.notes)}</p></details>` : ""}
      ${presentation.pending ? '<small role="status">Updating supported parameters…</small>' : ""}
    </div>
    ${hasUnknownModelSupport ? '<p class="muted" role="status">Model-specific support is unverified. Available controls follow provider capabilities.</p>' : ""}
    ${overviewWarnings.map((warning) => `<p class="config-model-parameter-warning" role="status">${escapeHtml(warning.message)}</p>`).join("")}
    ${renderParameterGroup("Sampling", sampling)}
    ${renderParameterGroup("Reasoning & limits", reasoning, reasoningFields)}
    ${advanced.length || advancedFields ? `<details class="config-model-parameter-advanced"><summary>Advanced</summary><div class="config-model-parameter-grid">${renderFields(advanced)}${advancedFields}</div></details>` : ""}
  </div>`;
}
