import { confirmDialog } from "./confirmation-dialog.js";
import { createModelPluginViewState } from "./config-workspace/model-plugin-view-state.js";
import { createConfigCalibrationDisclosure } from "./config-workspace/calibration-disclosure.js";
import { createConfigDashboardRendering } from "./config-workspace/dashboard-rendering.js";
import { createConfigFieldRendering } from "./config-workspace/field-rendering.js";
import { createConfigWorkspaceModel } from "./config-workspace/config-model.js";
import { createConfigModelRendering } from "./config-workspace/model-rendering.js";
import { createConfigStepRendering } from "./config-workspace/step-rendering.js";
import { createConfigWorkspaceEvents } from "./config-workspace/workspace-events.js";
import { createConfigWorkspaceMutations } from "./config-workspace/workspace-mutations.js";
import { createConfigWorkspacePersistence } from "./config-workspace/workspace-persistence.js";
import { createConfigWorkspaceView } from "./config-workspace/workspace-view.js";
import { configurationCategoryForWorkspace } from "../lib/configuration-pages.js";

export {
  configValuesEqual,
  executionPolicyValueForConfig,
  modelContextWindowValidationError,
  rawConfigDraftHasChanges,
  resolveModelExecutionRoute,
  runtimeConfigGraphChanged,
} from "./config-workspace/config-model.js";

export function createConfigWorkspace({
  dom,
  loadDashboard,
  loadModelPlugins,
  saveFile,
  memorySetup,
  memoryManagement,
  pluginManagement,
  getOperationsSummary,
  onAddModel,
  onRemoveModel,
  onNavigationChange = () => {},
  recordControlEvent,
  confirmDiscard = (message) => confirmDialog(message, { title: "Discard configuration changes", confirmLabel: "Discard changes", tone: "danger" }),
  eventTarget = window,
}) {
  const workspaceModel = createConfigWorkspaceModel();
  const { state } = workspaceModel;
  const modelPluginViewState = createModelPluginViewState(dom.configDashboard);
  const calibrationDisclosure = createConfigCalibrationDisclosure({
    state,
    root: dom.configDashboard,
  });
  let navigationRevision = 0;

  const fieldRendering = createConfigFieldRendering({
    state,
    configFileKey: workspaceModel.configFileKey,
    getConfigPathValue: workspaceModel.getConfigPathValue,
    hasPendingFileChanges: workspaceModel.hasPendingFileChanges,
    hasRawDraftChanges: workspaceModel.hasRawDraftChanges,
    isFileDirty: workspaceModel.isFileDirty,
  });

  const stepRendering = createConfigStepRendering({
    calibrationProfileDescription: fieldRendering.calibrationProfileDescription,
    calibrationProfileLabel: fieldRendering.calibrationProfileLabel,
    configStepTargetOptions: fieldRendering.configStepTargetOptions,
    configStepOptions: fieldRendering.configStepOptions,
    getConfigPathValue: workspaceModel.getConfigPathValue,
    renderFileActions: fieldRendering.renderFileActions,
    renderSelectOptions: fieldRendering.renderSelectOptions,
  });

  const modelRendering = createConfigModelRendering({
    modelPluginViewState,
    state,
    calibrationProfileLabel: fieldRendering.calibrationProfileLabel,
    configFileKey: workspaceModel.configFileKey,
    configProviderOptions: fieldRendering.configProviderOptions,
    configStepOptions: fieldRendering.configStepOptions,
    getConfigPathValue: workspaceModel.getConfigPathValue,
    renderConfigInput: fieldRendering.renderConfigInput,
    renderConfigTextarea: fieldRendering.renderConfigTextarea,
    renderExecutionRoute: fieldRendering.renderExecutionRoute,
    renderFileActions: fieldRendering.renderFileActions,
    renderSelectOptions: fieldRendering.renderSelectOptions,
  });

  const dashboardRendering = createConfigDashboardRendering({
    state,
    configFileEntries: workspaceModel.configFileEntries,
    configFileKey: workspaceModel.configFileKey,
    ensureRawSelection: workspaceModel.ensureRawSelection,
    fileStatusText: fieldRendering.fileStatusText,
    hasRawDraftChanges: workspaceModel.hasRawDraftChanges,
    isFileDirty: workspaceModel.isFileDirty,
    rawDraftFor: workspaceModel.rawDraftFor,
    selectedRawConfigFile: workspaceModel.selectedRawConfigFile,
  });

  const workspaceView = createConfigWorkspaceView({
    modelPluginViewState,
    onNavigationChange: () => {
      navigationRevision += 1;
      onNavigationChange();
    },
    state,
    dom,
    eventTarget,
    pluginManagement,
    getOperationsSummary,
    configFileEntries: workspaceModel.configFileEntries,
    configFileKey: workspaceModel.configFileKey,
    dashboardIsBusy: workspaceModel.dashboardIsBusy,
    ensureRawSelection: workspaceModel.ensureRawSelection,
    fileStatusText: fieldRendering.fileStatusText,
    hasPendingFileChanges: workspaceModel.hasPendingFileChanges,
    hasRawDraftChanges: workspaceModel.hasRawDraftChanges,
    isFileDirty: workspaceModel.isFileDirty,
    rawDraftFor: workspaceModel.rawDraftFor,
    renderCategoryPanel: dashboardRendering.renderCategoryPanel,
    renderConfigMap: dashboardRendering.renderConfigMap,
    renderModelList: modelRendering.renderModelList,
    renderSelectedModelEditor: modelRendering.renderSelectedModelEditor,
    renderStepsEditor: stepRendering.renderStepsEditor,
    selectedRawConfigFile: workspaceModel.selectedRawConfigFile,
  });

  const workspaceMutations = createConfigWorkspaceMutations({
    modelPluginViewState,
    state,
    dom,
    confirmDiscard,
    recordControlEvent,
    captureBaselines: workspaceModel.captureBaselines,
    configFileEntries: workspaceModel.configFileEntries,
    configFileKey: workspaceModel.configFileKey,
    dirtyFiles: workspaceModel.dirtyFiles,
    ensureRawSelection: workspaceModel.ensureRawSelection,
    findConfigFile: workspaceModel.findConfigFile,
    hasRawDraftChanges: workspaceModel.hasRawDraftChanges,
    rawDraftFor: workspaceModel.rawDraftFor,
    renderConfigDashboard: workspaceView.renderConfigDashboard,
    selectedRawConfigFile: workspaceModel.selectedRawConfigFile,
    setWorkspaceStatus: workspaceView.setWorkspaceStatus,
    syncDirtyPresentation: workspaceView.syncDirtyPresentation,
  });

  const workspacePersistence = createConfigWorkspacePersistence({
    state,
    dom,
    loadDashboard,
    loadModelPlugins,
    saveFile,
    memorySetup,
    memoryManagement,
    pluginManagement,
    recordControlEvent,
    applyRawDraft: workspaceMutations.applyRawDraft,
    baselineFor: workspaceModel.baselineFor,
    clearDashboardSnapshot: workspaceMutations.clearDashboardSnapshot,
    configFileKey: workspaceModel.configFileKey,
    confirmDiscardChanges: workspaceMutations.confirmDiscardChanges,
    dashboardIsBusy: workspaceModel.dashboardIsBusy,
    dirtyFiles: workspaceModel.dirtyFiles,
    findConfigFile: workspaceModel.findConfigFile,
    hasRawDraftChanges: workspaceModel.hasRawDraftChanges,
    hasUnsavedChanges: workspaceModel.hasUnsavedChanges,
    isFileDirty: workspaceModel.isFileDirty,
    replaceDashboard: workspaceMutations.replaceDashboard,
    setWorkspaceStatus: workspaceView.setWorkspaceStatus,
    syncDashboardInteractivity: workspaceView.syncDashboardInteractivity,
    syncDirtyPresentation: workspaceView.syncDirtyPresentation,
  });

  const workspaceEvents = createConfigWorkspaceEvents({
    modelPluginViewState,
    onAddModel,
    onRemoveModel,
    state,
    dom,
    eventTarget,
    applyRawDraft: workspaceMutations.applyRawDraft,
    changeRawFile: workspaceMutations.changeRawFile,
    configFileKey: workspaceModel.configFileKey,
    confirmDiscardChanges: workspaceMutations.confirmDiscardChanges,
    dashboardIsBusy: workspaceModel.dashboardIsBusy,
    deleteConfigPathValue: workspaceModel.deleteConfigPathValue,
    findConfigFile: workspaceModel.findConfigFile,
    hasUnsavedChanges: workspaceModel.hasUnsavedChanges,
    loadRuntimeConfig: workspacePersistence.loadRuntimeConfig,
    mutateConfigFile: workspaceMutations.mutateConfigFile,
    parseConfigInputValue: workspaceModel.parseConfigInputValue,
    parseConfigPath: workspaceModel.parseConfigPath,
    pruneEmptyExecutionConfig: workspaceModel.pruneEmptyExecutionConfig,
    renderConfigDashboard: workspaceView.renderConfigDashboard,
    resetConfigFile: workspaceMutations.resetConfigFile,
    saveConfigFile: workspacePersistence.saveConfigFile,
    saveRawDraft: workspacePersistence.saveRawDraft,
    selectedRawConfigFile: workspaceModel.selectedRawConfigFile,
    setConfigPathValue: workspaceModel.setConfigPathValue,
    setWorkspaceStatus: workspaceView.setWorkspaceStatus,
    syncDirtyPresentation: workspaceView.syncDirtyPresentation,
  });

  return {
    activeCategory: () => state.activeCategory,
    syncSummary: workspaceView.syncDashboardSummary,
    setActive: calibrationDisclosure.setActive,
    setWorkspace: (workspace) => {
      const category = configurationCategoryForWorkspace(workspace);
      calibrationDisclosure.setActive(Boolean(category));
      if (category) workspaceView.activateCategory(category);
    },
    activateCategory: workspaceView.activateCategory,
    beginExternalRuntimeMutation:
      workspacePersistence.beginExternalRuntimeMutation,
    bind: workspaceEvents.bind,
    confirmDiscardChanges: workspaceMutations.confirmDiscardChanges,
    endExternalRuntimeMutation: workspacePersistence.endExternalRuntimeMutation,
    hasUnsavedChanges: workspaceModel.hasUnsavedChanges,
    load: workspacePersistence.loadRuntimeConfig,
    navigationRevision: () => navigationRevision,
    selectModel: workspaceView.selectModel,
    setStatus: workspaceView.setWorkspaceStatus,
    focusSelectedModel: workspaceView.focusSelectedModel,
    prepareDiscardChanges: workspaceMutations.prepareDiscardChanges,
    refreshAfterExternalRuntimeMutation:
      workspacePersistence.refreshAfterExternalRuntimeMutation,
  };
}
