import { textOf } from "../../lib/text-format.js";
import {
  CONFIG_CATEGORIES,
  resolveModelExecutionRoute,
} from "./config-model.js";

export function createConfigWorkspaceEvents({
  state,
  dom,
  eventTarget,
  activateCategory,
  applyRawDraft,
  changeRawFile,
  configFileKey,
  confirmDiscardChanges,
  dashboardIsBusy,
  deleteConfigPathValue,
  findConfigFile,
  hasUnsavedChanges,
  loadRuntimeConfig,
  mutateConfigFile,
  parseConfigInputValue,
  parseConfigPath,
  pruneEmptyExecutionConfig,
  renderConfigDashboard,
  resetConfigFile,
  saveConfigFile,
  saveRawDraft,
  selectedRawConfigFile,
  setConfigPathValue,
  setWorkspaceStatus,
  syncDirtyPresentation,
}) {
  function configFieldUsesChangeEvent(element) {
    return element.matches("select, input[type=checkbox]");
  }

  function applyConfigFieldValue(config, element, path, value) {
    if (value !== undefined && value !== "") {
      setConfigPathValue(config, path, value);
      return;
    }
    deleteConfigPathValue(config, path);
    if (element.dataset.valueType !== "execution-policy") return;
    pruneEmptyExecutionConfig(config);
  }

  function syncExecutionRouteDescription(select) {
    if (select.dataset.valueType !== "execution-policy") return;
    const route = resolveModelExecutionRoute(select.value);
    const container = select.closest("[data-config-execution-route]");
    const label = container?.querySelector(
      "[data-config-execution-route-label]",
    );
    const description = container?.querySelector(
      "[data-config-execution-route-copy]",
    );
    if (label) label.textContent = route.label;
    if (description) description.textContent = route.description;
  }

  function handleFieldMutation(element) {
    const action = element.dataset.configAction;
    const path = parseConfigPath(element.dataset.path);
    const file = findConfigFile(element.dataset.kind, element.dataset.id);
    if (!file) return;
    const value =
      action === "step-value"
        ? element.value
        : parseConfigInputValue(element, file, path);
    mutateConfigFile(element.dataset.kind, element.dataset.id, (config) =>
      applyConfigFieldValue(config, element, path, value),
    );
    syncExecutionRouteDescription(element);
  }

  function handleDashboardInput(event) {
    if (dashboardIsBusy()) return;
    const element = event.target?.closest?.("[data-config-action]");
    if (!element || element.dataset.configAction !== "field") return;
    if (configFieldUsesChangeEvent(element)) return;
    handleFieldMutation(element);
  }

  function handleDashboardChange(event) {
    if (dashboardIsBusy()) return;
    const element = event.target;
    if (element?.id === "configRawFileSelect") {
      changeRawFile(element.value, element);
      return;
    }
    const actionElement = element?.closest?.("[data-config-action]");
    if (!actionElement) return;
    const action = actionElement.dataset.configAction;
    if (action === "step-value") {
      handleFieldMutation(actionElement);
      return;
    }
    if (action === "field" && configFieldUsesChangeEvent(actionElement)) {
      handleFieldMutation(actionElement);
    }
  }

  function handleCategoryKeydown(event, element) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const currentIndex = CONFIG_CATEGORIES.indexOf(
      element.dataset.configCategory,
    );
    let nextIndex = currentIndex;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = CONFIG_CATEGORIES.length - 1;
    if (event.key === "ArrowLeft") {
      nextIndex =
        (currentIndex - 1 + CONFIG_CATEGORIES.length) %
        CONFIG_CATEGORIES.length;
    }
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % CONFIG_CATEGORIES.length;
    }
    activateCategory(CONFIG_CATEGORIES[nextIndex], { focus: true });
  }

  function handleDashboardKeydown(event) {
    if (dashboardIsBusy()) return;
    const element = event.target?.closest?.("[data-config-category]");
    if (element) handleCategoryKeydown(event, element);
  }

  function handleDashboardToggle(event) {
    const details = event.target;
    if (details?.id === "configRawPanel") {
      state.rawPanelOpen = details.open;
      return;
    }
    const key = details?.dataset?.calibrationKey;
    if (!key) return;
    if (details.open) state.expandedCalibrationKeys.add(key);
    else state.expandedCalibrationKeys.delete(key);
  }

  function stepMappingIsComplete(step, profile) {
    return Boolean(step && profile);
  }

  function handleAddStepAction(element, kind, id) {
    const row = element.closest(".config-add-row");
    const step = textOf(
      row?.querySelector("[data-new-step-key]")?.value,
    ).trim();
    const profile = textOf(
      row?.querySelector("[data-new-step-value]")?.value,
    ).trim();
    if (!stepMappingIsComplete(step, profile)) return;
    const path = parseConfigPath(element.dataset.path);
    mutateConfigFile(
      kind,
      id,
      (config) => setConfigPathValue(config, [...path, step], profile),
      { rerender: true },
    );
  }

  function handleAddCalibrationAction(element, kind, id) {
    const row = element.closest(".config-add-row");
    const step = textOf(
      row?.querySelector("[data-new-calibration-key]")?.value,
    ).trim();
    if (!step) return;
    const file = findConfigFile(kind, id);
    if (!file) return;
    state.expandedCalibrationKeys.add(`${configFileKey(file)}:${step}`);
    mutateConfigFile(
      kind,
      id,
      (config) =>
        setConfigPathValue(config, ["calibration", step], {
          generation: {},
          context: {},
        }),
      { rerender: true },
    );
  }

  function handleDashboardClick(event) {
    if (dashboardIsBusy()) return;
    const element = event.target?.closest?.("[data-config-action]");
    if (!element) return;
    const action = element.dataset.configAction;
    const kind = element.dataset.kind;
    const id = element.dataset.id;
    if (action === "select-category") {
      activateCategory(element.dataset.configCategory || "memory");
      return;
    }
    if (action === "select-model") {
      state.selectedConfigModelId = element.dataset.modelId || "";
      renderConfigDashboard();
      return;
    }
    if (action === "save-file") {
      void saveConfigFile(kind, id).catch(() => {});
      return;
    }
    if (action === "reset-file") {
      resetConfigFile(kind, id);
      return;
    }
    if (action === "apply-raw") {
      applyRawDraft();
      return;
    }
    if (action === "save-raw") {
      void saveRawDraft().catch(() => {});
      return;
    }
    if (action === "delete-path") {
      const path = parseConfigPath(element.dataset.path);
      mutateConfigFile(
        kind,
        id,
        (config) => deleteConfigPathValue(config, path),
        { rerender: true },
      );
      return;
    }
    if (action === "add-step") {
      handleAddStepAction(element, kind, id);
      return;
    }
    if (action === "add-calibration") {
      handleAddCalibrationAction(element, kind, id);
    }
  }

  function handleRawEditorInput(event) {
    if (event.target?.id !== "configRawEditor") return;
    const file = selectedRawConfigFile();
    if (!file) return;
    state.rawDraftsByKey.set(configFileKey(file), event.target.value);
    state.savedKeys.delete(configFileKey(file));
    setWorkspaceStatus("");
    syncDirtyPresentation();
  }

  function handleBeforeUnload(event) {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    dom.refreshConfigButton.addEventListener("click", () => {
      if (dashboardIsBusy()) return;
      if (!confirmDiscardChanges("refresh configuration")) return;
      void loadRuntimeConfig({ protectUnsaved: false });
    });
    dom.configDashboard.addEventListener("click", handleDashboardClick);
    dom.configDashboard.addEventListener("input", handleDashboardInput);
    dom.configDashboard.addEventListener("input", handleRawEditorInput);
    dom.configDashboard.addEventListener("change", handleDashboardChange);
    dom.configDashboard.addEventListener("keydown", handleDashboardKeydown);
    dom.configDashboard.addEventListener("toggle", handleDashboardToggle, true);
    eventTarget.addEventListener?.("beforeunload", handleBeforeUnload);
  }

  return { bind };
}
