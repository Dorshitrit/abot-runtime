import {
  configRepairGuidance,
  configRequiresRawRepair,
} from "./raw-config-repair.js";
import { renderModelSetupEntry } from "./model-setup-entry.js";
import { escapeHtml, textOf } from "../../lib/text-format.js";
import { CONFIG_CATEGORIES } from "./config-model.js";

export function createConfigWorkspaceView({
  onNavigationChange = () => {},
  state,
  dom,
  eventTarget,
  pluginManagement,
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
  renderConfigMap,
  renderModelList,
  renderSelectedModelEditor,
  renderStepsEditor,
  selectedRawConfigFile,
}) {
  const operationsSection = dom.configDashboard.parentElement?.querySelector?.(
    "#configOperationsSection",
  );

  function mountOperationsSection() {
    if (!operationsSection) return;
    const panel = dom.configDashboard.querySelector("#configOperationsPanel");
    if (!panel) return;
    panel.appendChild(operationsSection);
    operationsSection.hidden = false;
  }

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
    if (
      configRequiresRawRepair(
        requestRunner,
        state.appliedJsonRepairKeys.has(configFileKey(requestRunner)),
      )
    )
      return '<p class="error-text">Repair this linked configuration file before editing pipeline settings.</p>';
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

  function renderUnavailableDashboard() {
    const unavailable =
      '<div class="empty-state">No config dashboard data</div>';
    dom.configDashboard.innerHTML =
      '<div class="config-category-panels">' +
      CONFIG_CATEGORIES.map((category) =>
        renderCategoryPanel(
          category,
          category === "operations" ? "" : unavailable,
        ),
      ).join("") +
      "</div>";
    mountOperationsSection();
  }

  function unavailableDashboardNeedsShell() {
    const filesUnavailable = !state.configDashboard?.files;
    const operationsPanelMissing = !dom.configDashboard.querySelector(
      "#configOperationsPanel",
    );
    return filesUnavailable && operationsPanelMissing;
  }

  function shouldLockConfigPanel(panel, busy) {
    return busy && panel.dataset.configCategoryPanel !== "operations";
  }

  function syncDashboardInteractivity() {
    if (unavailableDashboardNeedsShell()) renderUnavailableDashboard();
    const busy = dashboardIsBusy();
    dom.configDashboard.inert = false;
    for (const panel of dom.configDashboard.querySelectorAll(
      ".config-category-panel",
    )) {
      panel.inert = shouldLockConfigPanel(panel, busy);
    }
    dom.configDashboard.setAttribute("aria-busy", busy ? "true" : "false");
    dom.refreshConfigButton.disabled = busy;
  }

  function renderConfigDashboard() {
    const dashboard = state.configDashboard;
    if (!dashboard?.files) {
      renderUnavailableDashboard();
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
    const repairNeeded = configFileEntries().some((file) =>
      configRequiresRawRepair(
        file,
        state.appliedJsonRepairKeys.has(configFileKey(file)),
      ),
    );
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
      ${
        repairNeeded
          ? `<section class="config-category-panel" aria-label="Repair configuration file">${renderConfigMap()}</section>`
          : ""
      }
      <div class="config-category-panels">
        ${renderCategoryPanel(
          "models",
          `<section class="config-section models-section">
            ${renderModelSetupEntry(runtime, models)}
            <div class="config-model-layout">
              ${renderModelList(models)}
              ${renderSelectedModelEditor(models)}
            </div>
          </section>`,
        )}
        ${renderCategoryPanel("plugins", "<div data-plugin-management></div>")}
        ${renderCategoryPanel("operations", "")}
      </div>
    `;
    mountOperationsSection();
    pluginManagement?.mount(
      dom.configDashboard.querySelector("[data-plugin-management]"),
    );
    syncDirtyPresentation({ syncRawEditor: true });
    syncDashboardInteractivity();
  }

  function syncActiveCategory() {
    for (const panel of dom.configDashboard.querySelectorAll(
      "[data-config-category-panel]",
    )) {
      const active = panel.dataset.configCategoryPanel === state.activeCategory;
      panel.classList.toggle("active", active);
      panel.hidden = !active;
    }
  }

  function activateCategory(category) {
    if (!CONFIG_CATEGORIES.includes(category)) return;
    state.activeCategory = category;
    syncActiveCategory();
    onNavigationChange();
  }

  function selectModel(profileId) {
    const models = state.configDashboard?.files?.models || [];
    if (!models.some((model) => model.id === profileId)) return false;
    state.selectedConfigModelId = profileId;
    state.activeCategory = "models";
    renderConfigDashboard();
    onNavigationChange();
    return true;
  }

  function focusSelectedModel() {
    const buttons = Array.from(
      dom.configDashboard.querySelectorAll("[data-model-id]"),
    );
    const selected = buttons.find(
      (button) => button.dataset.modelId === state.selectedConfigModelId,
    );
    selected?.focus?.({ preventScroll: true });
    selected?.scrollIntoView?.({ block: "nearest" });
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
    const guidance = dom.configDashboard.querySelector(
      "#configRawRepairGuidance",
    );
    if (guidance) {
      guidance.textContent = configRepairGuidance(file);
      guidance.hidden = !guidance.textContent;
    }
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
    selectModel,
    focusSelectedModel,
    renderConfigDashboard,
    setWorkspaceStatus,
    syncDashboardInteractivity,
    syncDirtyPresentation,
  };
}
