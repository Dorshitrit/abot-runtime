import { escapeAttribute, escapeHtml, textOf } from "../../lib/text-format.js";
import {
  isConfigObject,
  MODEL_EXECUTION_ROUTES,
  resolveModelExecutionRoute,
} from "./config-model.js";

export function createConfigFieldRendering({
  state,
  configFileKey,
  getConfigPathValue,
  hasPendingFileChanges,
  hasRawDraftChanges,
  isFileDirty,
}) {
  function renderConfigInput(file, path, options = {}) {
    const value = getConfigPathValue(file.config, path);
    const type = options.type || "string";
    const pathValue = escapeAttribute(JSON.stringify(path));
    const common = `data-config-action="field" data-kind="${escapeAttribute(
      file.kind,
    )}" data-id="${escapeAttribute(file.id)}" data-path="${pathValue}" data-value-type="${escapeAttribute(
      type,
    )}"`;
    if (type === "boolean") {
      return `<label class="config-toggle"><input type="checkbox" ${common} ${
        value === true ? "checked" : ""
      } /><span>${escapeHtml(options.label || path.at(-1) || "")}</span></label>`;
    }
    if (type === "select") {
      const values = options.values || [];
      return `<select ${common}>${values
        .map((item) => {
          const selected = textOf(value) === item ? "selected" : "";
          return `<option value="${escapeAttribute(item)}" ${selected}>${escapeHtml(
            item || "default",
          )}</option>`;
        })
        .join("")}</select>`;
    }
    return `<input ${common} type="${type === "number" ? "number" : "text"}" value="${escapeAttribute(
      value ?? "",
    )}" ${options.min !== undefined ? `min="${escapeAttribute(options.min)}"` : ""} ${
      options.step !== undefined
        ? `step="${escapeAttribute(options.step)}"`
        : ""
    } />`;
  }

  function renderConfigTextarea(file, path, options = {}) {
    const value = getConfigPathValue(file.config, path);
    const pathValue = escapeAttribute(JSON.stringify(path));
    const rows = Number.isFinite(Number(options.rows))
      ? Number(options.rows)
      : 2;
    return `<textarea
      data-config-action="field"
      data-kind="${escapeAttribute(file.kind)}"
      data-id="${escapeAttribute(file.id)}"
      data-path="${pathValue}"
      data-value-type="string"
      rows="${escapeAttribute(String(rows))}"
      spellcheck="false"
    >${escapeHtml(value ?? "")}</textarea>`;
  }

  function renderExecutionRoute(file) {
    const path = ["execution", "policy"];
    const configuredPolicy = getConfigPathValue(file.config, path);
    const route = resolveModelExecutionRoute(configuredPolicy);
    const unsupportedOption = route.supported
      ? ""
      : `<option value="${escapeAttribute(route.policy)}" selected disabled>Unsupported · ${escapeHtml(
          route.policy,
        )}</option>`;
    const options = Object.entries(MODEL_EXECUTION_ROUTES)
      .map(
        ([policy, presentation]) => `
          <option value="${escapeAttribute(policy)}" ${
            route.policy === policy ? "selected" : ""
          }>${escapeHtml(presentation.label)}</option>
        `,
      )
      .join("");
    return `
      <div class="config-execution-route" data-config-execution-route>
        <label>
          <span>Execution route</span>
          <select
            aria-describedby="configExecutionRouteDescription"
            data-config-action="field"
            data-kind="${escapeAttribute(file.kind)}"
            data-id="${escapeAttribute(file.id)}"
            data-path="${escapeAttribute(JSON.stringify(path))}"
            data-value-type="execution-policy"
          >${unsupportedOption}${options}</select>
        </label>
        <div
          id="configExecutionRouteDescription"
          class="config-execution-route-copy"
          data-config-execution-route-description
          aria-live="polite"
        >
          <strong data-config-execution-route-label>${escapeHtml(
            route.label,
          )}</strong>
          <p data-config-execution-route-copy>${escapeHtml(
            route.description,
          )}</p>
        </div>
      </div>
    `;
  }

  function countObjectKeys(value) {
    return isConfigObject(value) ? Object.keys(value).length : 0;
  }

  function uniqueSorted(values) {
    return [
      ...new Set(
        values
          .map(textOf)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ].sort((left, right) => left.localeCompare(right));
  }

  function configProviderOptions() {
    const providers =
      state.configDashboard?.files?.runtime?.config?.models?.providers;
    return uniqueSorted(
      isConfigObject(providers) ? Object.keys(providers) : [],
    );
  }

  function configStepOptions() {
    const files = state.configDashboard?.files;
    const runnerSteps = files?.requestRunner?.config?.models?.defaults?.steps;
    const registeredSteps = Array.isArray(state.configDashboard?.modelSteps)
      ? state.configDashboard.modelSteps
      : [];
    return uniqueSorted([
      ...registeredSteps,
      ...(isConfigObject(runnerSteps) ? Object.keys(runnerSteps) : []),
    ]);
  }

  function configStepTargetOptions() {
    const files = state.configDashboard?.files;
    const runtimeModels = files?.runtime?.config?.models;
    const fromModelProfiles = isConfigObject(runtimeModels?.profiles)
      ? Object.keys(runtimeModels.profiles)
      : [];
    const fromInvocationProfiles = isConfigObject(
      runtimeModels?.invocationProfiles,
    )
      ? Object.keys(runtimeModels.invocationProfiles)
      : [];
    const runnerSteps = files?.requestRunner?.config?.models?.defaults?.steps;
    const fromRunnerSteps = isConfigObject(runnerSteps)
      ? Object.values(runnerSteps)
      : [];
    const fromCalibration = (files?.models || []).flatMap((model) => {
      const calibration = model.config?.calibration;
      return isConfigObject(calibration) ? Object.keys(calibration) : [];
    });
    return uniqueSorted([
      ...fromRunnerSteps,
      ...fromModelProfiles,
      ...fromInvocationProfiles,
      ...fromCalibration,
    ]);
  }

  function calibrationProfileMetadataFrom(file, profileId) {
    const metadata = file?.config?.calibration;
    const entry = isConfigObject(metadata) ? metadata[profileId] : null;
    return isConfigObject(entry) ? entry : {};
  }

  function calibrationProfileMetadata(profileId) {
    const models = state.configDashboard?.files?.models || [];
    const selectedModel = models.find(
      (model) => model.id === state.selectedConfigModelId,
    );
    const candidates = [
      selectedModel,
      ...models.filter((model) => model !== selectedModel),
    ].filter(Boolean);
    for (const file of candidates) {
      const entry = calibrationProfileMetadataFrom(file, profileId);
      if (entry.name || entry.description) return entry;
    }
    return {};
  }

  function calibrationProfileLabel(profileId) {
    return (
      textOf(calibrationProfileMetadata(profileId).name).trim() || profileId
    );
  }

  function calibrationProfileDescription(profileId) {
    return textOf(calibrationProfileMetadata(profileId).description).trim();
  }

  function renderSelectOptions(values, selectedValue = "", options = {}) {
    const selected = textOf(selectedValue);
    return uniqueSorted([selected, ...values])
      .map((value) => {
        const label = options.labelFor ? options.labelFor(value) : value;
        return `<option value="${escapeAttribute(value)}" ${
          value === selected ? "selected" : ""
        }>${escapeHtml(label || value)}</option>`;
      })
      .join("");
  }

  function fileStatusText(file) {
    const key = configFileKey(file);
    if (state.savingKeys.has(key)) return "Saving…";
    if (hasRawDraftChanges(file)) return "Raw draft not applied";
    if (isFileDirty(file)) return "Unsaved changes";
    if (state.savedKeys.has(key)) return "Saved";
    return "Clean";
  }

  function renderFileActions(file) {
    const key = configFileKey(file);
    const pending = hasPendingFileChanges(file);
    const dirty = isFileDirty(file);
    const saving = state.savingKeys.has(key);
    const label = textOf(file.label || file.id || file.kind);
    return `
      <div class="config-file-actions">
        <span
          class="config-file-status ${pending ? "dirty" : ""}"
          data-config-file-status="${escapeAttribute(key)}"
          role="status"
          aria-live="polite"
        >${escapeHtml(fileStatusText(file))}</span>
        <button
          type="button"
          data-config-action="reset-file"
          data-kind="${escapeAttribute(file.kind)}"
          data-id="${escapeAttribute(file.id)}"
          aria-label="Reset ${escapeAttribute(label)}"
          ${pending && !saving ? "" : "disabled"}
        >Reset</button>
        <button
          type="button"
          data-config-action="save-file"
          data-kind="${escapeAttribute(file.kind)}"
          data-id="${escapeAttribute(file.id)}"
          aria-label="Save ${escapeAttribute(label)}"
          ${dirty && !saving ? "" : "disabled"}
        >Save</button>
      </div>
    `;
  }

  return {
    calibrationProfileDescription,
    calibrationProfileLabel,
    configStepTargetOptions,
    configProviderOptions,
    configStepOptions,
    countObjectKeys,
    fileStatusText,
    renderConfigInput,
    renderConfigTextarea,
    renderExecutionRoute,
    renderFileActions,
    renderSelectOptions,
  };
}
