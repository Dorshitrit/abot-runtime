import { escapeAttribute, escapeHtml, textOf } from "../../lib/text-format.js";
import { isConfigObject } from "./config-model.js";

export function createConfigStepRendering({
  calibrationProfileDescription,
  calibrationProfileLabel,
  configStepTargetOptions,
  configStepOptions,
  getConfigPathValue,
  renderFileActions,
  renderSelectOptions,
}) {
  function stepsObject(file, path) {
    const value = getConfigPathValue(file.config, path);
    return isConfigObject(value) ? value : {};
  }

  function stepTargetCountLabel(count, sparseOverrides) {
    const noun = sparseOverrides ? "override" : "mapping";
    return `${count} ${count === 1 ? noun : `${noun}s`}`;
  }

  function renderStepsEditor(file, title, path, options = {}) {
    const sparseOverrides = options.sparseOverrides === true;
    const steps = stepsObject(file, path);
    const stepOptions = configStepOptions();
    const availableStepOptions = stepOptions.filter(
      (step) => !Object.prototype.hasOwnProperty.call(steps, step),
    );
    const targetOptions = configStepTargetOptions();
    const count = Object.keys(steps).length;
    const sectionTitle = sparseOverrides ? "Routing overrides" : title;
    const countLabel = stepTargetCountLabel(count, sparseOverrides);
    const targetColumnLabel = sparseOverrides
      ? "Override target"
      : "Mapping target";
    const targetControlLabel = sparseOverrides
      ? "Override target"
      : "Mapping target";
    const rows = Object.entries(steps)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([step, target]) => {
        const targetId = textOf(target);
        const description = calibrationProfileDescription(targetId);
        return `
          <div class="config-step-row">
            <div class="config-step-key"><span>${escapeHtml(step)}</span></div>
            <div class="config-profile-select-cell">
              <select
                aria-label="${targetControlLabel} for ${escapeAttribute(step)}"
                data-config-action="step-value"
                data-kind="${escapeAttribute(file.kind)}"
                data-id="${escapeAttribute(file.id)}"
                data-path="${escapeAttribute(JSON.stringify([...path, step]))}"
              >
                ${renderSelectOptions(targetOptions, targetId, {
                  labelFor: calibrationProfileLabel,
                })}
              </select>
              <small>${escapeHtml(
                description || calibrationProfileLabel(targetId) || targetId,
              )}</small>
            </div>
            ${
              sparseOverrides
                ? `<button
                    class="config-icon-button"
                    type="button"
                    aria-label="Remove ${escapeAttribute(step)} override"
                    data-config-action="delete-path"
                    data-kind="${escapeAttribute(file.kind)}"
                    data-id="${escapeAttribute(file.id)}"
                    data-path="${escapeAttribute(JSON.stringify([...path, step]))}"
                  >Remove</button>`
                : "<span></span>"
            }
          </div>
        `;
      })
      .join("");
    return `
      <section class="config-section config-steps-section">
        <div class="config-section-header">
          <div class="config-file-meta">
            <h3>${escapeHtml(sectionTitle)}</h3>
            <p>${escapeHtml(countLabel)}${
              sparseOverrides
                ? " · Unmapped steps use their own model step id."
                : ""
            }</p>
            <code>${escapeHtml(file.path)}</code>
          </div>
          ${renderFileActions(file)}
        </div>
        <div class="config-step-list">
            ${
              rows
                ? `<div class="config-step-header"><span>Model step</span><span>${targetColumnLabel}</span><span></span></div>${rows}`
                : `<div class="empty-state compact">${
                    sparseOverrides
                      ? "No routing overrides. Registered steps use their own model step ids."
                      : "No steps configured"
                  }</div>`
            }
          </div>
          <div class="config-add-row">
            <div class="config-add-copy">
              <strong>${sparseOverrides ? "Add override" : "Add mapping"}</strong>
              <span>${
                sparseOverrides
                  ? "Override the identity target for a registered model step."
                  : "Route a model step to a mapping target."
              }</span>
            </div>
          <label>
            <span>Model step</span>
            <select data-new-step-key>
              <option value="">Choose step</option>
              ${renderSelectOptions(availableStepOptions)}
            </select>
          </label>
          <label>
            <span>${sparseOverrides ? "Target" : "Mapping target"}</span>
            <select data-new-step-value>
              <option value="">Choose target</option>
              ${renderSelectOptions(targetOptions, "", {
                labelFor: calibrationProfileLabel,
              })}
            </select>
          </label>
          <button
            type="button"
            data-config-action="add-step"
            data-kind="${escapeAttribute(file.kind)}"
            data-id="${escapeAttribute(file.id)}"
            data-path="${escapeAttribute(JSON.stringify(path))}"
            ${availableStepOptions.length ? "" : "disabled"}
          >Add</button>
        </div>
      </section>
    `;
  }

  return { renderStepsEditor };
}
