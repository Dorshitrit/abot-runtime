import { modelParameterPresentation } from "./model-parameters.js";
import { modelParameterInputDraftEntries, modelParameterInputValidationError, setModelParameterInputDraft } from "./model-parameter-input-drafts.js";

function parameterGenerationPath(element) {
  try {
    const path = JSON.parse(element.dataset.generationPath);
    if (path.length === 1 && path[0] === "generation") return path;
    if (path.length === 3 && path[0] === "calibration" && typeof path[1] === "string" && path[2] === "generation") return path;
  } catch { /* Ignore a stale or malformed control. */ }
  return undefined;
}

function canEditParameter(field) {
  if (!field?.supported) return false;
  return field.modelSupport !== "unsupported";
}

function hasValidExplicitValue(field, value) {
  if (field.values && !field.values.includes(value)) return false;
  if (field.type === "enum") return field.values?.includes(value) === true;
  if (field.type === "bool") return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (field.type === "int" && !Number.isSafeInteger(value)) return false;
  if (field.min !== undefined && value < field.min) return false;
  if (field.max !== undefined && value > field.max) return false;
  return true;
}

function explicitControlValue(field, element) {
  if (element.validity?.badInput) return undefined;
  if (element.value.trim() === "") return field.editingValue ? undefined : { mode: "omit" };
  let value = element.value;
  if (field.type === "bool") value = element.value === "true";
  if (field.type === "number" || field.type === "int") value = Number(element.value);
  if (!hasValidExplicitValue(field, value)) return undefined;
  return { mode: "value", value };
}

function selectedControl(field, element) {
  if (element.dataset.configAction === "model-parameter-value") return explicitControlValue(field, element);
  if (element.value === "omit" || element.value === "inherit") return { mode: element.value };
  if (element.value !== "value") return undefined;
  const saved = field.control?.mode === "value" ? field.control.value : field.configuredValue;
  const value = [saved, field.value, field.recommended].find((candidate) => hasValidExplicitValue(field, candidate));
  return value === undefined ? undefined : { mode: "value", value };
}

function opensEmptyCustomValue(element, fields, changes) {
  if (changes.length > 0 || fields.length === 0) return false;
  if (element.dataset.configAction !== "model-parameter-mode") return false;
  return element.value === "value";
}

function invalidInputMessage(field) {
  const bounds = [field.min === undefined ? "" : `at least ${field.min}`, field.max === undefined ? "" : `at most ${field.max}`].filter(Boolean);
  const type = field.type === "int" ? "an integer" : "a valid value";
  return `${field.label} must be ${type}${bounds.length ? ` (${bounds.join(" and ")})` : ""} before saving.`;
}

function isRejectedParameterInput(element, fields, changes) {
  if (element.dataset.configAction !== "model-parameter-value") return false;
  if (!fields.length || changes.length) return false;
  return element.validity?.badInput || element.value.trim() !== "";
}

export function createModelParameterEdits({ state, findConfigFile, mutateConfigFile, setConfigPathValue, deleteConfigPathValue, refreshPreview, invalidatePreview = () => {}, renderConfigDashboard, setWorkspaceStatus = () => {}, syncDirtyPresentation = () => {} }) {
  function writeControl(config, path, field, control) {
    setConfigPathValue(config, [...path, "parameters", field.key], control);
    for (const legacyKey of field.legacyKeys ?? []) deleteConfigPathValue(config, [...path, legacyKey]);
  }

  function applyControlChanges(file, path, changes) {
    for (const { field } of changes) setModelParameterInputDraft(file.config, path, field.key, undefined);
    mutateConfigFile("model", file.id, (config) => {
      for (const { field, control } of changes) writeControl(config, path, field, control);
    });
    for (const { field, control } of changes) {
      delete field.editingValue;
      Object.assign(field, { control, explicit: control.mode === "value", omitted: control.mode === "omit", source: "manual" });
      if (control.mode === "value") field.value = control.value;
      else delete field.value;
    }
  }

  function reconcileDrafts(modelId, presentation) {
    const file = findConfigFile("model", modelId);
    if (!file) return;
    const drafts = modelParameterInputDraftEntries(file.config);
    for (const { path, key, draft } of drafts) {
      const scope = path[0] === "calibration" ? presentation.calibration?.[path[1]] : presentation.model;
      const field = scope?.parameters.find((entry) => entry.key === key);
      if (!canEditParameter(field)) {
        setModelParameterInputDraft(file.config, path, key, undefined);
        const message = `${field?.label ?? key} input was discarded because this parameter is unavailable for the selected target. Saved controls were kept.`;
        (scope ?? presentation.model).warnings.push({ code: "parameter_input_draft_unsupported", message });
        setWorkspaceStatus(message);
        continue;
      }
      const control = explicitControlValue(field, { value: draft.text, validity: { badInput: draft.badInput } });
      if (!control) {
        const error = invalidInputMessage(field);
        setModelParameterInputDraft(file.config, path, key, { ...draft, error });
        scope.stale = true;
        setWorkspaceStatus(error, "error-text");
        continue;
      }
      applyControlChanges(file, path, [{ field, control }]);
      setWorkspaceStatus("");
    }
    if (drafts.length) syncDirtyPresentation();
  }

  function retainInvalidInput(file, path, field, element, commit) {
    const error = invalidInputMessage(field);
    setModelParameterInputDraft(file.config, path, field.key, { text: element.value, error, badInput: element.validity?.badInput === true });
    element.setCustomValidity?.(error);
    element.setAttribute?.("aria-invalid", "true");
    syncDirtyPresentation();
    if (!commit) return;
    setWorkspaceStatus(error, "error-text");
    element.reportValidity?.();
  }

  function clearEmptyInput(file, path, fields, element) {
    if (element.dataset.configAction !== "model-parameter-value") return;
    for (const field of fields) setModelParameterInputDraft(file.config, path, field.key, undefined);
    element.setCustomValidity?.("");
    element.removeAttribute?.("aria-invalid");
    if (fields.some((field) => field.editingError)) setWorkspaceStatus("");
    syncDirtyPresentation();
  }

  function handle(element, { commit = true } = {}) {
    if (!element.dataset.configAction?.startsWith("model-parameter")) return false;
    const file = findConfigFile("model", element.dataset.id);
    const path = parameterGenerationPath(element);
    if (!file || !path) return true;
    const presentation = modelParameterPresentation(state, file, path);
    if (!presentation) return true;
    const recommended = element.dataset.configAction === "model-parameters-recommended";
    if (recommended && (presentation.pending || presentation.stale || modelParameterInputValidationError(file.config))) return true;
    const fields = presentation.parameters.filter((field) => canEditParameter(field) &&
      (recommended ? hasValidExplicitValue(field, field.recommended) : field.key === element.dataset.parameterKey));
    const changes = fields.flatMap((field) => {
      const control = recommended ? { mode: "value", value: field.recommended } : selectedControl(field, element);
      return control ? [{ field, control }] : [];
    });
    if (isRejectedParameterInput(element, fields, changes)) {
      retainInvalidInput(file, path, fields[0], element, commit);
      return true;
    }
    if (opensEmptyCustomValue(element, fields, changes)) {
      invalidatePreview();
      for (const field of fields) field.editingValue = true;
      renderConfigDashboard();
      return true;
    }
    if (!changes.length) {
      clearEmptyInput(file, path, fields, element);
      return true;
    }
    if (changes.some(({ field }) => field.editingError)) setWorkspaceStatus("");
    element.setCustomValidity?.("");
    element.removeAttribute?.("aria-invalid");
    applyControlChanges(file, path, changes);
    if (!commit) return true;
    if (recommended || element.dataset.configAction === "model-parameter-mode") renderConfigDashboard();
    void refreshPreview();
    return true;
  }
  return { handle, reconcileDrafts };
}
