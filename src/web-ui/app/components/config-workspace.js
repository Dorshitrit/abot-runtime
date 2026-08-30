import { createConfigDashboardRendering } from "./config-workspace/dashboard-rendering.js";
import { createConfigFieldRendering } from "./config-workspace/field-rendering.js";
import { createConfigWorkspaceModel } from "./config-workspace/config-model.js";
import { createConfigModelRendering } from "./config-workspace/model-rendering.js";
import { createConfigStepRendering } from "./config-workspace/step-rendering.js";
import { createConfigWorkspaceEvents } from "./config-workspace/workspace-events.js";
import { createConfigWorkspaceMutations } from "./config-workspace/workspace-mutations.js";
import { createConfigWorkspacePersistence } from "./config-workspace/workspace-persistence.js";
import { createConfigWorkspaceView } from "./config-workspace/workspace-view.js";

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
  saveFile,
  memorySetup,
  memoryManagement,
  recordControlEvent,
  confirmDiscard = (message) => window.confirm(message),
  eventTarget = window,
}) {
  const workspaceModel = createConfigWorkspaceModel();
  const { state } = workspaceModel;

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
    state,
    dom,
    eventTarget,
    memorySetup,
    memoryManagement,
    configFileEntries: workspaceModel.configFileEntries,
    configFileKey: workspaceModel.configFileKey,
    countObjectKeys: fieldRendering.countObjectKeys,
    dashboardIsBusy: workspaceModel.dashboardIsBusy,
    dirtyFiles: workspaceModel.dirtyFiles,
    ensureRawSelection: workspaceModel.ensureRawSelection,
    fileStatusText: fieldRendering.fileStatusText,
    hasPendingFileChanges: workspaceModel.hasPendingFileChanges,
    hasRawDraftChanges: workspaceModel.hasRawDraftChanges,
    isFileDirty: workspaceModel.isFileDirty,
    rawDraftFor: workspaceModel.rawDraftFor,
    renderCategoryPanel: dashboardRendering.renderCategoryPanel,
    renderCategoryTab: dashboardRendering.renderCategoryTab,
    renderConfigMap: dashboardRendering.renderConfigMap,
    renderModelList: modelRendering.renderModelList,
    renderSelectedModelEditor: modelRendering.renderSelectedModelEditor,
    renderStepsEditor: stepRendering.renderStepsEditor,
    selectedRawConfigFile: workspaceModel.selectedRawConfigFile,
  });

  const workspaceMutations = createConfigWorkspaceMutations({
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
    saveFile,
    memorySetup,
    memoryManagement,
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
    state,
    dom,
    eventTarget,
    activateCategory: workspaceView.activateCategory,
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
    beginExternalRuntimeMutation:
      workspacePersistence.beginExternalRuntimeMutation,
    bind: workspaceEvents.bind,
    confirmDiscardChanges: workspaceMutations.confirmDiscardChanges,
    endExternalRuntimeMutation: workspacePersistence.endExternalRuntimeMutation,
    hasUnsavedChanges: workspaceModel.hasUnsavedChanges,
    load: workspacePersistence.loadRuntimeConfig,
    prepareDiscardChanges: workspaceMutations.prepareDiscardChanges,
    refreshAfterExternalRuntimeMutation:
      workspacePersistence.refreshAfterExternalRuntimeMutation,
  };
}
