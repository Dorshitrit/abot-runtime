import { escapeAttribute, escapeHtml, textOf } from "../../lib/text-format.js";
import { isConfigObject } from "./config-model.js";

export function createConfigModelRendering({
  state,
  calibrationProfileLabel,
  configFileKey,
  configProviderOptions,
  configStepOptions,
  getConfigPathValue,
  renderConfigInput,
  renderConfigTextarea,
  renderExecutionRoute,
  renderFileActions,
  renderSelectOptions,
}) {
  function renderModelList(models) {
    return `
      <div class="config-model-list" aria-label="Model profiles">
        <div class="config-model-list-title">
          <span>Model profiles</span>
          <small>${escapeHtml(String(models.length))}</small>
        </div>
        ${models
          .map((model) => {
            const active = model.id === state.selectedConfigModelId;
            const capabilities = model.config?.capabilities?.inputModalities;
            const hasImage =
              Array.isArray(capabilities) && capabilities.includes("image");
            return `
              <button
                class="config-model-button ${active ? "active" : ""}"
                type="button"
                data-config-action="select-model"
                data-model-id="${escapeAttribute(model.id)}"
                aria-pressed="${active ? "true" : "false"}"
                ${active ? 'aria-current="true"' : ""}
              >
                <span>${escapeHtml(model.config?.label || model.id)}</span>
                <small>
                  <span>${escapeHtml(model.config?.provider || "-")}</span>
                  <span>${escapeHtml(hasImage ? "image input" : "text input")}</span>
                </small>
              </button>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderCalibrationFormat(file, path) {
    const value = getConfigPathValue(file.config, path);
    if (isConfigObject(value)) {
      return `
        <div class="config-readonly-field" data-config-custom-format>
          <strong>Custom JSON schema</strong>
          <small>Edit in Raw JSON.</small>
        </div>
      `;
    }
    return renderConfigInput(file, path, {
      type: "select",
      values: ["", "json"],
    });
  }

  function renderCalibrationCard(file, stepId, profile) {
    const basePath = ["calibration", stepId];
    const displayName =
      textOf(profile?.name).trim() || calibrationProfileLabel(stepId);
    const description = textOf(profile?.description).trim();
    const calibrationKey = `${configFileKey(file)}:${stepId}`;
    const expanded = state.expandedCalibrationKeys.has(calibrationKey);
    return `
      <details
        class="config-calibration-card"
        data-calibration-key="${escapeAttribute(calibrationKey)}"
        ${expanded ? "open" : ""}
      >
        <summary class="config-calibration-title">
          <span>
            <strong>${escapeHtml(displayName)}</strong>
            <small>${escapeHtml(description || "No description")}</small>
          </span>
          <code>${escapeHtml(stepId)}</code>
        </summary>
        <div class="config-calibration-body">
          <div class="config-calibration-meta">
            <label class="config-calibration-name-field">
              <span>Name</span>
              ${renderConfigInput(file, [...basePath, "name"])}
            </label>
            <label class="config-calibration-description-field">
              <span>Description</span>
              ${renderConfigTextarea(file, [...basePath, "description"], {
                rows: 2,
              })}
            </label>
          </div>
          <div class="config-field-grid">
            <label><span>Format</span>${renderCalibrationFormat(file, [
              ...basePath,
              "format",
            ])}</label>
            <label><span>Temperature</span>${renderConfigInput(
              file,
              [...basePath, "generation", "temperature"],
              { type: "number", step: "0.01" },
            )}</label>
            <label><span>Top P</span>${renderConfigInput(
              file,
              [...basePath, "generation", "topP"],
              { type: "number", step: "0.01" },
            )}</label>
            <label><span>Reasoning</span>${renderConfigInput(
              file,
              [...basePath, "generation", "reasoningEffort"],
              {
                type: "select",
                values: [
                  "",
                  "none",
                  "minimal",
                  "low",
                  "medium",
                  "high",
                  "xhigh",
                ],
              },
            )}</label>
          </div>
          <button
            class="config-icon-button config-calibration-remove"
            type="button"
            aria-label="Remove ${escapeAttribute(displayName)} calibration"
            data-config-action="delete-path"
            data-kind="${escapeAttribute(file.kind)}"
            data-id="${escapeAttribute(file.id)}"
            data-path="${escapeAttribute(JSON.stringify(basePath))}"
          >Remove profile</button>
        </div>
      </details>
    `;
  }

  function renderSelectedModelEditor(models) {
    const model =
      models.find((item) => item.id === state.selectedConfigModelId) ||
      models[0];
    if (!model) {
      return '<div class="empty-state compact">No model configs found</div>';
    }
    state.selectedConfigModelId = model.id;
    const calibration = isConfigObject(model.config?.calibration)
      ? model.config.calibration
      : {};
    const calibrationCards = Object.entries(calibration)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([stepId, profile]) => renderCalibrationCard(model, stepId, profile))
      .join("");
    const availableCalibrationProfiles = configStepOptions().filter(
      (step) => !Object.prototype.hasOwnProperty.call(calibration, step),
    );
    return `
      <section class="config-section config-model-editor">
        <div class="config-section-header">
          <div class="config-file-meta">
            <h3>${escapeHtml(model.config?.label || model.id)}</h3>
            <p>${escapeHtml(
              `${model.config?.provider || "provider"} · ${
                model.config?.model || model.id
              }`,
            )}</p>
            <code>${escapeHtml(model.path)}</code>
          </div>
          ${renderFileActions(model)}
        </div>
        <div class="config-form-panel">
          <div class="config-form-panel-title">
            <strong>Model defaults</strong>
            <span>Provider, generation, and base context limits.</span>
          </div>
          <div class="config-field-grid model-basics">
            <label><span>Label</span>${renderConfigInput(model, ["label"])}</label>
            <label><span>Provider</span>${renderConfigInput(
              model,
              ["provider"],
              { type: "select", values: configProviderOptions() },
            )}</label>
            <label><span>Model</span>${renderConfigInput(model, ["model"])}</label>
            ${renderConfigInput(model, ["supportsThinking"], {
              type: "boolean",
              label: "Thinking",
            })}
            <label><span>Temperature</span>${renderConfigInput(
              model,
              ["generation", "temperature"],
              { type: "number", step: "0.01" },
            )}</label>
            <label><span>Top P</span>${renderConfigInput(
              model,
              ["generation", "topP"],
              { type: "number", step: "0.01" },
            )}</label>
            <label><span>Context window</span>${renderConfigInput(
              model,
              ["contextWindowTokens"],
              { type: "number", min: "1", step: "1" },
            )}</label>
          </div>
          ${renderExecutionRoute(model)}
        </div>
        <div class="config-subheader">
          <div>
            <span>Invocation calibration</span>
            <small>${escapeHtml(
              Object.keys(calibration).length === 1
                ? "1 profile"
                : `${Object.keys(calibration).length} profiles`,
            )}</small>
          </div>
          <div class="config-add-row compact">
            <label>
              <span>Add profile</span>
              <select data-new-calibration-key>
                <option value="">Choose invocation profile</option>
                ${renderSelectOptions(availableCalibrationProfiles)}
              </select>
            </label>
            <button
              type="button"
              data-config-action="add-calibration"
              data-kind="model"
              data-id="${escapeAttribute(model.id)}"
              ${availableCalibrationProfiles.length ? "" : "disabled"}
            >Add</button>
          </div>
        </div>
        <div class="config-calibration-grid">
          ${
            calibrationCards ||
            '<div class="empty-state compact">No calibration entries</div>'
          }
        </div>
      </section>
    `;
  }

  return { renderModelList, renderSelectedModelEditor };
}
