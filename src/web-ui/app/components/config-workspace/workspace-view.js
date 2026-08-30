import { escapeHtml, textOf } from "../../lib/text-format.js";
import { CONFIG_CATEGORIES } from "./config-model.js";

export function createConfigWorkspaceView({
  state,
  dom,
  eventTarget,
  memorySetup,
  memoryManagement,
  configFileEntries,
  configFileKey,
  countObjectKeys,
  dashboardIsBusy,
  dirtyFiles,
  ensureRawSelection,
  fileStatusText,
  hasPendingFileChanges,
  hasRawDraftChanges,
  isFileDirty,
  rawDraftFor,
  renderCategoryPanel,
  renderCategoryTab,
  renderConfigMap,
  renderModelList,
  renderSelectedModelEditor,
  renderStepsEditor,
  selectedRawConfigFile,
}) {
  function selectedConfigModelIsAvailable(models) {
    return (
      Boolean(state.selectedConfigModelId) &&
      models.some((model) => model.id === state.selectedConfigModelId)
    );
  }

  function requestRunnerUsesSparseOverrides(requestRunner) {
    return requestRunner?.config?.schemaVersion === 2;
  }

  function configuredStepTargetCountLabel(count, sparseOverrides) {
    const noun = sparseOverrides ? "override" : "mapping";
    return `${count} ${count === 1 ? noun : `${noun}s`}`;
  }

  function configChangeSummary(count) {
    if (count === 0) return "All saved";
    const fileLabel = count === 1 ? "file" : "files";
    return `${count} unsaved ${fileLabel}`;
  }

  function requestPipelineContent(requestRunner) {
    if (!requestRunner) {
      return '<div class="empty-state compact">No request runner config found</div>';
    }
    return renderStepsEditor(
      requestRunner,
      "Request pipeline",
      ["models", "defaults", "steps"],
      {
        sparseOverrides: requestRunnerUsesSparseOverrides(requestRunner),
      },
    );
  }

  function shouldSynchronizeRawEditor(editor, options) {
    if (!editor) return false;
    if (!options.syncRawEditor) return false;
    return editor !== eventTarget.document?.activeElement;
  }

  function syncDashboardInteractivity() {
    const busy = dashboardIsBusy();
    dom.configDashboard.inert = busy;
    dom.configDashboard.setAttribute("aria-busy", busy ? "true" : "false");
    dom.refreshConfigButton.disabled = busy;
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
    if (!selectedConfigModelIsAvailable(models)) {
      state.selectedConfigModelId = models[0]?.id || "";
    }
    ensureRawSelection();
    const registeredStepCount = Array.isArray(dashboard.modelSteps)
      ? dashboard.modelSteps.length
      : 0;
    const configuredStepTargetCount = requestRunner
      ? countObjectKeys(requestRunner.config?.models?.defaults?.steps)
      : 0;
    const sparseOverrides = requestRunnerUsesSparseOverrides(requestRunner);
    const configuredStepTargetLabel = configuredStepTargetCountLabel(
      configuredStepTargetCount,
      sparseOverrides,
    );
    const dirtyCount = dirtyFiles().length;
    dom.configDashboard.innerHTML = `
      <dl class="config-summary" aria-label="Configuration summary">
        <div class="config-summary-item">
          <dt>Runtime</dt>
          <dd class="config-summary-value">${escapeHtml(
            runtime?.exists ? "Ready" : "Missing",
          )}</dd>
        </div>
        <div class="config-summary-item">
          <dt>Pipeline</dt>
          <dd class="config-summary-value">
            <span data-config-registered-step-count>${escapeHtml(
              `${registeredStepCount} registered`,
            )}</span>
            <span aria-hidden="true"> · </span>
            <span data-config-step-target-count>${escapeHtml(
              configuredStepTargetLabel,
            )}</span>
          </dd>
        </div>
        <div class="config-summary-item">
          <dt>Models</dt>
          <dd class="config-summary-value">${escapeHtml(String(models.length))}</dd>
        </div>
        <div class="config-summary-item config-summary-changes">
          <dt>Changes</dt>
          <dd
            class="config-summary-value ${dirtyCount ? "dirty" : ""}"
            data-config-summary-status
            role="status"
            aria-live="polite"
          >${escapeHtml(configChangeSummary(dirtyCount))}</dd>
        </div>
      </dl>
      <nav class="config-category-nav" role="tablist" aria-label="Configuration categories">
        ${renderCategoryTab("memory", "Memory")}
        ${renderCategoryTab("pipeline", "Pipeline")}
        ${renderCategoryTab("models", "Models")}
        ${renderCategoryTab("advanced", "Advanced")}
      </nav>
      <div class="config-category-panels">
        ${renderCategoryPanel(
          "memory",
          '<div class="config-memory-layout"><div data-long-term-memory-setup></div><div data-long-term-memory-management></div></div>',
        )}
        ${renderCategoryPanel(
          "pipeline",
          requestPipelineContent(requestRunner),
        )}
        ${renderCategoryPanel(
          "models",
          `<section class="config-section models-section">
            <div class="config-model-layout">
              ${renderModelList(models)}
              ${renderSelectedModelEditor(models)}
            </div>
          </section>`,
        )}
        ${renderCategoryPanel("advanced", renderConfigMap())}
      </div>
    `;
    memorySetup.mount(
      dom.configDashboard.querySelector("[data-long-term-memory-setup]"),
    );
    memoryManagement.mount(
      dom.configDashboard.querySelector("[data-long-term-memory-management]"),
    );
    syncDirtyPresentation({ syncRawEditor: true });
  }

  function syncActiveCategory() {
    for (const button of dom.configDashboard.querySelectorAll(
      "[data-config-category]",
    )) {
      const active = button.dataset.configCategory === state.activeCategory;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    }
    for (const panel of dom.configDashboard.querySelectorAll(
      "[data-config-category-panel]",
    )) {
      const active = panel.dataset.configCategoryPanel === state.activeCategory;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
    }
  }

  function activateCategory(category, options = {}) {
    if (!CONFIG_CATEGORIES.includes(category)) return;
    state.activeCategory = category;
    syncActiveCategory();
    if (options.focus) {
      dom.configDashboard
        .querySelector(`[data-config-category="${category}"]`)
        ?.focus();
    }
  }

  function syncFileControls() {
    for (const file of configFileEntries()) {
      const key = configFileKey(file);
      const pending = hasPendingFileChanges(file);
      const dirty = isFileDirty(file);
      const saving = state.savingKeys.has(key);
      for (const status of dom.configDashboard.querySelectorAll(
        "[data-config-file-status]",
      )) {
        if (status.dataset.configFileStatus !== key) continue;
        status.textContent = fileStatusText(file);
        status.classList.toggle("dirty", pending);
      }
      for (const button of dom.configDashboard.querySelectorAll(
        '[data-config-action="reset-file"]',
      )) {
        if (
          button.dataset.kind === file.kind &&
          button.dataset.id === file.id
        ) {
          button.disabled = !pending || saving;
        }
      }
      for (const button of dom.configDashboard.querySelectorAll(
        '[data-config-action="save-file"]',
      )) {
        if (
          button.dataset.kind === file.kind &&
          button.dataset.id === file.id
        ) {
          button.disabled = !dirty || saving;
        }
      }
    }
  }

  function syncDashboardSummary() {
    const status = dom.configDashboard.querySelector(
      "[data-config-summary-status]",
    );
    if (!status) return;
    const count = dirtyFiles().length;
    status.textContent = configChangeSummary(count);
    status.classList.toggle("dirty", count > 0);
  }

  function syncRawControls(options = {}) {
    const select = dom.configDashboard.querySelector("#configRawFileSelect");
    const editor = dom.configDashboard.querySelector("#configRawEditor");
    const applyButton = dom.configDashboard.querySelector(
      "#configApplyRawButton",
    );
    const saveButton = dom.configDashboard.querySelector(
      "#configSaveRawButton",
    );
    const status = dom.configDashboard.querySelector(".config-raw-status");
    const file = selectedRawConfigFile();
    if (!file) return;
    if (select) select.value = state.selectedRawConfigKey;
    if (shouldSynchronizeRawEditor(editor, options)) {
      editor.value = rawDraftFor(file);
    }
    const rawDirty = hasRawDraftChanges(file);
    const fileDirty = isFileDirty(file);
    const pending = rawDirty || fileDirty;
    const saving = state.savingKeys.has(configFileKey(file));
    if (applyButton) applyButton.disabled = !rawDirty || saving;
    if (saveButton) saveButton.disabled = !pending || saving;
    if (status) {
      status.textContent = rawDirty
        ? "Draft not applied"
        : fileStatusText(file);
      status.classList.toggle("dirty", pending);
    }
  }

  function syncDirtyPresentation(options = {}) {
    syncFileControls();
    syncDashboardSummary();
    syncRawControls(options);
  }

  function setWorkspaceStatus(message, tone = "") {
    dom.configStatus.textContent = textOf(message);
    dom.configStatus.className = `config-workspace-status ${tone}`.trim();
  }

  return {
    activateCategory,
    renderConfigDashboard,
    setWorkspaceStatus,
    syncDashboardInteractivity,
    syncDirtyPresentation,
  };
}
