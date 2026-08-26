import { escapeAttribute, escapeHtml, textOf } from "../lib/text-format.js";

export function createConfigWorkspace({
  dom,
  loadDashboard,
  saveFile,
  recordControlEvent,
}) {
  const state = {
    configDashboard: null,
    selectedConfigModelId: "",
    selectedRawConfigKey: "",
    bound: false,
  };

  async function loadRuntimeConfig() {
    dom.configStatus.textContent = "Loading...";
    dom.configDashboard.innerHTML = "";
    dom.configRawEditor.value = "";
    try {
      const payload = await loadDashboard();
      state.configDashboard = payload.dashboard || null;
      const dashboard = state.configDashboard;
      const files = configFileEntries();
      if (!state.selectedConfigModelId && dashboard?.files?.models?.length) {
        state.selectedConfigModelId = dashboard.files.models[0].id;
      }
      if (!state.selectedRawConfigKey && files.length) {
        state.selectedRawConfigKey = configFileKey(files[0]);
      }
      dom.configStatus.innerHTML = "";
      renderConfigDashboard();
      renderRawConfigSelector();
    } catch (error) {
      dom.configStatus.innerHTML = `<span class="error-text">${escapeHtml(
        error instanceof Error ? error.message : String(error),
      )}</span>`;
      dom.configDashboard.innerHTML = "";
      dom.configRawEditor.value = "";
    }
  }

  function configFileKey(file) {
    return `${textOf(file?.kind)}:${textOf(file?.id)}`;
  }

  function configFileEntries() {
    const files = state.configDashboard?.files;
    if (!files) return [];
    return [
      files.runtime,
      files.requestRunner,
      ...(Array.isArray(files.models) ? files.models : []),
    ].filter(Boolean);
  }

  function findConfigFile(kind, id = "") {
    return configFileEntries().find(
      (file) => file.kind === kind && (!id || file.id === id),
    );
  }

  function getConfigPathValue(config, path) {
    let current = config;
    for (const key of path) {
      if (!current || typeof current !== "object") return undefined;
      current = current[key];
    }
    return current;
  }

  function setConfigPathValue(config, path, value) {
    let current = config;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      if (!current[key] || typeof current[key] !== "object") {
        current[key] = {};
      }
      current = current[key];
    }
    current[path[path.length - 1]] = value;
  }

  function deleteConfigPathValue(config, path) {
    let current = config;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      if (!current?.[key] || typeof current[key] !== "object") return;
      current = current[key];
    }
    delete current[path[path.length - 1]];
  }

  function parseConfigPath(value) {
    try {
      const parsed = JSON.parse(textOf(value));
      return Array.isArray(parsed) ? parsed.map(textOf) : [];
    } catch {
      return [];
    }
  }

  function parseConfigInputValue(input) {
    const type = input.dataset.valueType || "string";
    if (type === "boolean") return input.checked;
    if (type === "number") {
      if (input.value.trim() === "") return undefined;
      const value = Number(input.value);
      return Number.isFinite(value) ? value : undefined;
    }
    return input.value;
  }

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
    )}" ${options.step ? `step="${escapeAttribute(options.step)}"` : ""} />`;
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

  function renderConfigMetric(label, value) {
    return `
      <div class="config-metric">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `;
  }

  function countObjectKeys(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).length
      : 0;
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
    const runtime = state.configDashboard?.files?.runtime;
    const providers = runtime?.config?.models?.providers;
    return uniqueSorted(
      providers && typeof providers === "object" && !Array.isArray(providers)
        ? Object.keys(providers)
        : [],
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
      ...(runnerSteps && typeof runnerSteps === "object"
        ? Object.keys(runnerSteps)
        : []),
    ]);
  }

  function configInvocationProfileOptions() {
    const files = state.configDashboard?.files;
    const fromRunnerSteps = Object.values(
      files?.requestRunner?.config?.models?.defaults?.steps || {},
    );
    const fromCalibration = (files?.models || []).flatMap((model) => {
      const calibration = model.config?.calibration;
      return calibration && typeof calibration === "object"
        ? Object.keys(calibration)
        : [];
    });
    return uniqueSorted([...fromRunnerSteps, ...fromCalibration]);
  }

  function calibrationProfileMetadataFrom(file, profileId) {
    const metadata = file?.config?.calibration;
    const entry =
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata[profileId]
        : null;
    return entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry
      : {};
  }

  function calibrationProfileMetadata(profileId) {
    const files = state.configDashboard?.files;
    const models = files?.models || [];
    const selectedModel = models.find(
      (model) => model.id === state.selectedConfigModelId,
    );
    const candidates = [
      selectedModel,
      ...models.filter((model) => model !== selectedModel),
    ].filter(Boolean);
    for (const file of candidates) {
      const entry = calibrationProfileMetadataFrom(file, profileId);
      if (entry.name || entry.description) {
        return entry;
      }
    }
    return {};
  }

  function calibrationProfileLabel(profileId) {
    const metadata = calibrationProfileMetadata(profileId);
    return textOf(metadata.name).trim() || profileId;
  }

  function calibrationProfileDescription(profileId) {
    return textOf(calibrationProfileMetadata(profileId).description).trim();
  }

  function renderSelectOptions(values, selectedValue = "", options = {}) {
    const selected = textOf(selectedValue);
    const allValues = uniqueSorted([selected, ...values]);
    return allValues
      .map((value) => {
        const isSelected = value === selected;
        const label = options.labelFor ? options.labelFor(value) : value;
        return `<option value="${escapeAttribute(value)}" ${
          isSelected ? "selected" : ""
        }>${escapeHtml(label || value)}</option>`;
      })
      .join("");
  }

  function stepsObject(file, path) {
    const value = getConfigPathValue(file.config, path);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }

  function renderStepsEditor(file, title, path) {
    const steps = stepsObject(file, path);
    const stepOptions = configStepOptions();
    const profileOptions = configInvocationProfileOptions();
    const count = Object.keys(steps).length;
    const rows = Object.entries(steps)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([step, profile]) => {
        const profileId = textOf(profile);
        const description = calibrationProfileDescription(profileId);
        const profileLabel = calibrationProfileLabel(profileId);
        return `
          <div class="config-step-row">
            <div class="config-step-key">
              <span>${escapeHtml(step)}</span>
            </div>
            <div class="config-profile-select-cell">
              <select
                data-config-action="step-value"
                data-kind="${escapeAttribute(file.kind)}"
                data-id="${escapeAttribute(file.id)}"
                data-path="${escapeAttribute(JSON.stringify([...path, step]))}"
              >
                ${renderSelectOptions(profileOptions, profileId, {
                  labelFor: calibrationProfileLabel,
                })}
              </select>
              ${
                description
                  ? `<small>${escapeHtml(description)}</small>`
                  : `<small>${escapeHtml(profileLabel || profileId)}</small>`
              }
            </div>
            <button
              class="config-icon-button"
              type="button"
              title="Remove step"
              data-config-action="delete-path"
              data-kind="${escapeAttribute(file.kind)}"
              data-id="${escapeAttribute(file.id)}"
              data-path="${escapeAttribute(JSON.stringify([...path, step]))}"
            >×</button>
          </div>
        `;
      })
      .join("");
    return `
      <section class="config-section config-steps-section">
        <div class="config-section-header">
          <div>
            <h4>${escapeHtml(title)}</h4>
            <p>${escapeHtml(count === 1 ? "1 mapping" : `${count} mappings`)}</p>
          </div>
          <code>${escapeHtml(file.path)}</code>
          <button type="button" data-config-action="save-file" data-kind="${escapeAttribute(
            file.kind,
          )}" data-id="${escapeAttribute(file.id)}">Save</button>
        </div>
        <div class="config-step-list">
          ${
            rows
              ? `<div class="config-step-header"><span>Model step</span><span>Invocation profile</span><span></span></div>${rows}`
              : '<div class="empty-state compact">No steps configured</div>'
          }
        </div>
        <div class="config-add-row">
          <div class="config-add-copy">
            <strong>Add mapping</strong>
            <span>Route a model step to an invocation profile.</span>
          </div>
          <label>
            <span>Model step</span>
            <select data-new-step-key>
              <option value="">Choose step</option>
              ${renderSelectOptions(stepOptions)}
            </select>
          </label>
          <label>
            <span>Invocation profile</span>
            <select data-new-step-value>
              <option value="">Choose profile</option>
              ${renderSelectOptions(profileOptions, "", {
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
          >Add</button>
        </div>
      </section>
    `;
  }

  function renderModelList(models) {
    return `
      <div class="config-model-list">
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

  function renderCalibrationCard(file, stepId, profile) {
    const basePath = ["calibration", stepId];
    const displayName =
      textOf(profile?.name).trim() || calibrationProfileLabel(stepId);
    const description = textOf(profile?.description).trim();
    return `
      <article class="config-calibration-card">
        <div class="config-calibration-title">
          <div>
            <strong>${escapeHtml(displayName)}</strong>
            <span>${escapeHtml(description || "No description yet")}</span>
          </div>
          <code>${escapeHtml(stepId)}</code>
          <button
            class="config-icon-button"
            type="button"
            title="Remove calibration"
            data-config-action="delete-path"
            data-kind="${escapeAttribute(file.kind)}"
            data-id="${escapeAttribute(file.id)}"
            data-path="${escapeAttribute(JSON.stringify(basePath))}"
          >×</button>
        </div>
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
          <label><span>Format</span>${renderConfigInput(
            file,
            [...basePath, "format"],
            {
              type: "select",
              values: ["", "json"],
            },
          )}</label>
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
              values: ["", "none", "minimal", "low", "medium", "high", "xhigh"],
            },
          )}</label>
        </div>
      </article>
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
    const calibration =
      model.config?.calibration &&
      typeof model.config.calibration === "object" &&
      !Array.isArray(model.config.calibration)
        ? model.config.calibration
        : {};
    const calibrationCards = Object.entries(calibration)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([stepId, profile]) => renderCalibrationCard(model, stepId, profile))
      .join("");
    return `
      <section class="config-section config-model-editor">
        <div class="config-section-header">
          <div>
            <h4>${escapeHtml(model.config?.label || model.id)}</h4>
            <p>${escapeHtml(model.path)}</p>
          </div>
          <div class="config-section-actions">
            <span>${escapeHtml(model.config?.provider || "provider")} · ${escapeHtml(
              model.config?.model || model.id,
            )}</span>
          <button type="button" data-config-action="save-file" data-kind="model" data-id="${escapeAttribute(
            model.id,
          )}">Save</button>
          </div>
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
              {
                type: "select",
                values: configProviderOptions(),
              },
            )}</label>
            <label><span>Model</span>${renderConfigInput(model, ["model"])}</label>
            ${renderConfigInput(model, ["supportsThinking"], {
              type: "boolean",
              label: "Thinking",
            })}
            <label><span>Temperature</span>${renderConfigInput(
              model,
              ["generation", "temperature"],
              {
                type: "number",
                step: "0.01",
              },
            )}</label>
            <label><span>Top P</span>${renderConfigInput(
              model,
              ["generation", "topP"],
              {
                type: "number",
                step: "0.01",
              },
            )}</label>
            <label><span>Context window</span>${renderConfigInput(
              model,
              ["contextWindowTokens"],
              {
                type: "number",
              },
            )}</label>
          </div>
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
              ${renderSelectOptions(configStepOptions())}
              </select>
            </label>
            <button
              type="button"
              data-config-action="add-calibration"
              data-kind="model"
              data-id="${escapeAttribute(model.id)}"
            >Add</button>
          </div>
        </div>
        <div class="config-calibration-grid">
          ${calibrationCards || '<div class="empty-state compact">No calibration entries</div>'}
        </div>
      </section>
    `;
  }

  function renderConfigDashboard() {
    const dashboard = state.configDashboard;
    if (!dashboard?.files) {
      dom.configDashboard.innerHTML =
        '<div class="empty-state">No config dashboard data</div>';
      return;
    }
    const runtime = dashboard.files.runtime;
    const requestRunner = dashboard.files.requestRunner;
    const models = Array.isArray(dashboard.files.models)
      ? dashboard.files.models
      : [];
    const runnerSteps = requestRunner
      ? countObjectKeys(requestRunner.config?.models?.defaults?.steps)
      : 0;
    dom.configDashboard.innerHTML = `
      <div class="config-dashboard-header">
        <div>
          <p class="eyebrow">configuration workspace</p>
          <h3>Runtime configuration</h3>
          <span>Manage request routing and per-model calibration from one workspace.</span>
        </div>
        <div class="config-dashboard-context">
          <code>${escapeHtml(dashboard.configDir || ".")}</code>
        </div>
      </div>
      <div class="config-hero">
        ${renderConfigMetric("Runtime", runtime?.exists ? "ready" : "missing")}
        ${renderConfigMetric("Runner steps", String(runnerSteps))}
        ${renderConfigMetric("Orchestration", "Supervisor")}
        ${renderConfigMetric("Models", String(models.length))}
      </div>
      <div class="config-dashboard-grid">
        <div class="config-loop-grid">
          ${
            requestRunner
              ? renderStepsEditor(requestRunner, "Request pipeline", [
                  "models",
                  "defaults",
                  "steps",
                ])
              : ""
          }
        </div>
        <section class="config-section models-section">
          <div class="config-section-header">
            <div>
              <h4>Models</h4>
              <p>Model files and per-step calibration</p>
            </div>
            <span class="config-section-kicker">calibration workspace</span>
          </div>
          <div class="config-model-layout">
            ${renderModelList(models)}
            ${renderSelectedModelEditor(models)}
          </div>
        </section>
        <section class="config-section config-files-section">
          <div class="config-section-header">
            <div>
              <h4>Config map</h4>
              <p>Linked files loaded by this runtime config</p>
            </div>
            <button type="button" data-config-action="save-file" data-kind="runtime" data-id="runtime">Save</button>
          </div>
          <div class="config-file-list">
            ${configFileEntries()
              .map(
                (file) => `
                  <div class="config-file-row">
                    <span>${escapeHtml(file.label)}</span>
                    <code>${escapeHtml(file.path)}</code>
                  </div>
                `,
              )
              .join("")}
          </div>
        </section>
      </div>
    `;
    bindConfigDashboardControls();
  }

  function renderRawConfigSelector() {
    const files = configFileEntries();
    dom.configRawFileSelect.innerHTML = files
      .map(
        (file) =>
          `<option value="${escapeAttribute(configFileKey(file))}">${escapeHtml(
            file.label,
          )}</option>`,
      )
      .join("");
    if (
      !files.some((file) => configFileKey(file) === state.selectedRawConfigKey)
    ) {
      state.selectedRawConfigKey = files[0] ? configFileKey(files[0]) : "";
    }
    dom.configRawFileSelect.value = state.selectedRawConfigKey;
    syncRawConfigEditor();
  }

  function selectedRawConfigFile() {
    return configFileEntries().find(
      (file) => configFileKey(file) === state.selectedRawConfigKey,
    );
  }

  function syncRawConfigEditor() {
    const file = selectedRawConfigFile();
    dom.configRawEditor.value = file
      ? JSON.stringify(file.config || {}, null, 2)
      : "";
  }

  function mutateConfigFile(kind, id, mutator) {
    const file = findConfigFile(kind, id);
    if (!file) return;
    mutator(file.config);
    renderConfigDashboard();
    renderRawConfigSelector();
  }

  async function saveConfigFile(kind, id) {
    const file = findConfigFile(kind, id);
    if (!file) return;
    const result = await saveFile({ kind, id, config: file.config });
    recordControlEvent({
      type: "control",
      name: "Config saved",
      tone: "done",
      summary: result.backupPath
        ? `backup: ${result.backupPath}`
        : "restart required",
    });
    await loadRuntimeConfig();
  }

  function bindConfigDashboardControls() {
    dom.configDashboard
      .querySelectorAll("[data-config-action]")
      .forEach((element) => {
        const action = element.dataset.configAction;
        if (action === "field" || action === "step-value") {
          element.addEventListener("change", () => {
            const path = parseConfigPath(element.dataset.path);
            const value =
              action === "step-value"
                ? element.value
                : parseConfigInputValue(element);
            mutateConfigFile(
              element.dataset.kind,
              element.dataset.id,
              (config) => {
                if (value === undefined || value === "") {
                  deleteConfigPathValue(config, path);
                } else {
                  setConfigPathValue(config, path, value);
                }
              },
            );
          });
          return;
        }
        element.addEventListener("click", () => {
          const kind = element.dataset.kind;
          const id = element.dataset.id;
          if (action === "select-model") {
            state.selectedConfigModelId = element.dataset.modelId || "";
            renderConfigDashboard();
            return;
          }
          if (action === "save-file") {
            void saveConfigFile(kind, id).catch((error) => {
              recordControlEvent({
                type: "control",
                name: "Config save failed",
                tone: "failed",
                summary: error instanceof Error ? error.message : String(error),
              });
            });
            return;
          }
          if (action === "delete-path") {
            const path = parseConfigPath(element.dataset.path);
            mutateConfigFile(kind, id, (config) =>
              deleteConfigPathValue(config, path),
            );
            return;
          }
          if (action === "add-step") {
            const row = element.closest(".config-add-row");
            const step = textOf(
              row?.querySelector("[data-new-step-key]")?.value,
            ).trim();
            const profile = textOf(
              row?.querySelector("[data-new-step-value]")?.value,
            ).trim();
            if (!step || !profile) return;
            const path = parseConfigPath(element.dataset.path);
            mutateConfigFile(kind, id, (config) =>
              setConfigPathValue(config, [...path, step], profile),
            );
            return;
          }
          if (action === "add-calibration") {
            const row = element.closest(".config-add-row");
            const step = textOf(
              row?.querySelector("[data-new-calibration-key]")?.value,
            ).trim();
            if (!step) return;
            mutateConfigFile(kind, id, (config) =>
              setConfigPathValue(config, ["calibration", step], {
                generation: {},
                context: {},
              }),
            );
          }
        });
      });
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    dom.refreshConfigButton.addEventListener("click", () => {
      void loadRuntimeConfig();
    });
    dom.configRawFileSelect.addEventListener("change", () => {
      state.selectedRawConfigKey = dom.configRawFileSelect.value;
      syncRawConfigEditor();
    });
    dom.configApplyRawButton.addEventListener("click", () => {
      const file = selectedRawConfigFile();
      if (!file) return;
      try {
        const parsed = JSON.parse(dom.configRawEditor.value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Raw config must be a JSON object");
        }
        file.config = parsed;
        renderConfigDashboard();
        renderRawConfigSelector();
      } catch (error) {
        recordControlEvent({
          type: "control",
          name: "Raw config invalid",
          tone: "failed",
          summary: error instanceof Error ? error.message : String(error),
        });
      }
    });
    dom.configSaveRawButton.addEventListener("click", () => {
      const file = selectedRawConfigFile();
      if (!file) return;
      try {
        const parsed = JSON.parse(dom.configRawEditor.value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Raw config must be a JSON object");
        }
        file.config = parsed;
        void saveConfigFile(file.kind, file.id).catch((error) => {
          recordControlEvent({
            type: "control",
            name: "Config save failed",
            tone: "failed",
            summary: error instanceof Error ? error.message : String(error),
          });
        });
      } catch (error) {
        recordControlEvent({
          type: "control",
          name: "Raw config invalid",
          tone: "failed",
          summary: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  return { bind, load: loadRuntimeConfig };
}
