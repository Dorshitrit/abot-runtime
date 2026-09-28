import { createModelSetupWizard } from "./components/model-setup/wizard.js";
import { createRuntimeConfigActivation } from "./components/runtime-config-activation.js";
import { createPluginManager } from "./components/plugins/manager.js";
import { createComputerAccessFeature } from "./computer-access-feature.js";
import { createHomeGuidance } from "./components/home-guidance/home-guidance.js";
import { createConfigWorkspace } from "./components/config-workspace.js";
import { createModelRemovalController } from "./components/config-workspace/model-removal.js";
import { createLongTermMemorySetup } from "./components/long-term-memory-setup.js";
import { createLongTermMemoryManager } from "./components/long-term-memory/manager.js";
import { createMemoryWorkspace } from "./components/long-term-memory/workspace.js";
import { createLongTermMemoryController } from "./controllers/long-term-memory/controller.js";

export function createConfigurationFeature({
  dom,
  runtimeClient,
  selectedEnvironmentId,
  recordControlEvent,
  onNavigationChange = () => {},
  onConfigurationApplied = async () => {},
  onConfigurationSettled = () => true,
  getLearningSnapshot = () => null,
  isRuntimeReady = () => true,
}) {
  let configWorkspace;
  let activation;
  let modelSetup;
  let modelRemoval;
  const longTermMemorySetup = createLongTermMemorySetup({
    getEnvironmentId: selectedEnvironmentId,
    loadStatus: (environmentId) =>
      runtimeClient.loadLongTermMemoryStatus(environmentId),
    discoverModels: (providerId, environmentId) =>
      runtimeClient.discoverLongTermMemoryModels({
        environmentId,
        providerId,
      }),
    enableMemory: async (input, environmentId) => {
      const result = await runtimeClient.enableLongTermMemory({
        environmentId,
        ...input,
      });
      activation?.markPending();
      return result;
    },
    disableMemory: async (environmentId) => {
      const result = await runtimeClient.disableLongTermMemory(environmentId);
      activation?.markPending();
      return result;
    },
    recordControlEvent,
    beginRuntimeMutation: () =>
      configWorkspace?.beginExternalRuntimeMutation() ?? false,
    refreshRuntimeConfig: () =>
      configWorkspace?.refreshAfterExternalRuntimeMutation() ??
      Promise.resolve(false),
    endRuntimeMutation: () => configWorkspace?.endExternalRuntimeMutation(),
  });

  let longTermMemoryManager;
  const longTermMemoryController = createLongTermMemoryController({
    client: runtimeClient,
    getEnvironmentId: selectedEnvironmentId,
    render: (snapshot) => longTermMemoryManager?.render(snapshot),
  });
  longTermMemoryManager = createLongTermMemoryManager({
    actions: longTermMemoryController,
  });
  longTermMemorySetup.mount(dom.memorySetupRoot);
  longTermMemoryManager.mount(dom.memoryManagementRoot);
  const memoryWorkspace = createMemoryWorkspace({
    root: dom.memoryWorkspacePanel,
  });

  const pluginManager = createPluginManager({
    getEnvironmentId: selectedEnvironmentId,
    onConfigurationSaved: () => activation?.markPending(),
    loadPlugins: () => runtimeClient.getRuntimePlugins(),
    setPlugin: (input) => runtimeClient.setRuntimePlugin(input),
    beginRuntimeMutation: (subject) =>
      configWorkspace?.beginExternalRuntimeMutation(subject) ?? false,
    refreshRuntimeConfig: (failurePrefix) =>
      configWorkspace?.refreshAfterExternalRuntimeMutation(failurePrefix) ??
      Promise.resolve(false),
    endRuntimeMutation: () => configWorkspace?.endExternalRuntimeMutation(),
    recordControlEvent,
  });

  let homeSetupSuggestion;
  const computerAccess = createComputerAccessFeature({
    dom,
    runtimeClient,
    onChange: () => homeSetupSuggestion?.render(),
  });
  homeSetupSuggestion = createHomeGuidance({
    container: dom.homeDashboardRoot?.querySelector(".home-workspace-content"),
    homeRegion: dom.homeWorkspacePanel,
    client: runtimeClient,
    getEnvironmentId: selectedEnvironmentId,
    getLearningSnapshot,
    isRuntimeReady,
    // Computer access is permanently visible above the Home suggestions.
    getConnectionState: () => null,
    supportsConnection: () => false,
    refreshConnection: () => {},
    onOpen: (id) => {
      if (id === "coworker") return dom.learningWorkspaceButton?.click();
      if (id === "memory") {
        dom.memoryWorkspaceButton?.click();
        if (dom.memoryWorkspacePanel?.hidden === false)
          memoryWorkspace.activate("setup");
        return;
      }
      dom.pluginsWorkspaceButton?.click();
    },
  });
  configWorkspace = createConfigWorkspace({
    onNavigationChange,
    onRemoveModel: (model) => {
      if (modelSetup?.isOpen()) return;
      return modelRemoval.remove(model);
    },
    dom: {
      refreshConfigButton: dom.refreshConfigButton,
      configStatus: dom.configStatus,
      configDashboard: dom.configDashboard,
    },
    loadDashboard: () =>
      runtimeClient.loadConfigDashboard(selectedEnvironmentId()),
    saveFile: async ({ kind, id, config, expectedRevision }) => {
      const result = await runtimeClient.saveConfigFile({
        environmentId: selectedEnvironmentId(),
        kind,
        id,
        config,
        expectedRevision,
      });
      activation?.markPending();
      return result;
    },
    onAddModel: async (options) => {
      if (modelSetup?.isOpen()) return;
      if (!configWorkspace.beginExternalRuntimeMutation("model setup")) return;
      configWorkspace.endExternalRuntimeMutation();
      try {
        await modelSetup.open(options);
      } catch {
        dom.configStatus.textContent =
          "Model setup could not be opened. Try again.";
      }
    },
    memorySetup: longTermMemorySetup,
    pluginManagement: pluginManager,
    memoryManagement: {
      load: () => longTermMemoryController.load(),
      mount: (root) => longTermMemoryManager.mount(root),
    },
    recordControlEvent,
  });

  activation = createRuntimeConfigActivation({
    onAppliedSettled: () => onConfigurationSettled(),
    root: dom.configDashboard.parentElement,
    getWorkspace: () => configWorkspace,
    apply: () =>
      runtimeClient.applyRuntimeConfiguration(selectedEnvironmentId()),
    getEnvironmentId: selectedEnvironmentId,
    refresh: async () => {
      const refreshed = await configWorkspace.load({ protectUnsaved: false });
      if (refreshed) pluginManager.markApplied?.();
      await onConfigurationApplied();
      return refreshed;
    },
  });
  modelRemoval = createModelRemovalController({
    removeModel: (input, environmentId) =>
      runtimeClient.removeRuntimeModel(input, environmentId),
    loadDashboard: (environmentId) =>
      runtimeClient.loadConfigDashboard(environmentId, { settled: true }),
    getEnvironmentId: selectedEnvironmentId,
    beginRuntimeMutation: (subject) =>
      configWorkspace.beginExternalRuntimeMutation(subject),
    endRuntimeMutation: () => configWorkspace.endExternalRuntimeMutation(),
    refreshRuntimeConfig: (prefix) =>
      configWorkspace.refreshAfterExternalRuntimeMutation(prefix),
    onSaved: () => activation.markPending(),
    setStatus: (...args) => configWorkspace.setStatus(...args),
  });
  modelSetup = createModelSetupWizard({
    root: dom.configDashboard.parentElement,
    getEnvironmentId: selectedEnvironmentId,
    loadSetup: () => runtimeClient.loadModelSetup(selectedEnvironmentId()),
    saveModel: (input) =>
      runtimeClient.addRuntimeModel(input, selectedEnvironmentId()),
    applySetup: () =>
      runtimeClient.applyRuntimeConfiguration(selectedEnvironmentId()),
    beginRuntimeMutation: () =>
      configWorkspace.beginExternalRuntimeMutation("model setup"),
    endRuntimeMutation: () => configWorkspace.endExternalRuntimeMutation(),
    onSaved: () => activation.markPending(),
    onDeferred: async (model) => {
      const refreshed =
        await configWorkspace.refreshAfterExternalRuntimeMutation(
          "Model saved; refresh required",
        );
      if (!refreshed) return false;
      return configWorkspace.selectModel(model.profileId);
    },
    onComplete: async (model) => {
      activation.markApplied();
      try {
        const refreshed =
          await configWorkspace.refreshAfterExternalRuntimeMutation(
            "Model added; refresh required",
          );
        if (!refreshed) return false;
        const memoryRefreshed = await longTermMemorySetup.load();
        if (!memoryRefreshed) return false;
        pluginManager.markApplied?.();
        return configWorkspace.selectModel(model.profileId);
      } finally {
        await onConfigurationApplied();
      }
    },
    onClosed: ({ completed }) => {
      if (completed) configWorkspace.focusSelectedModel();
      onConfigurationSettled();
    },
  });

  const prepareDiscardChanges = configWorkspace.prepareDiscardChanges;
  return {
    ...configWorkspace,
    openComputerSetup: computerAccess.open,
    refreshComputerAccess: computerAccess.load,
    renderHomeGuidance: () => homeSetupSuggestion.render(),
    showActivityMemories: () => {
      memoryWorkspace.activate("memories");
      void longTermMemoryController.setOriginFilter("passive_observation");
      longTermMemoryManager.focus();
    },
    prepareDiscardChanges: (...args) => {
      if (modelSetup.isOpen()) {
        dom.configStatus.textContent =
          "Finish or cancel model setup before leaving configuration.";
        return null;
      }
      return prepareDiscardChanges(...args);
    },
  };
}
