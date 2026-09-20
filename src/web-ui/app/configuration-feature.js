import { createModelSetupWizard } from "./components/model-setup/wizard.js";
import { createRuntimeConfigActivation } from "./components/runtime-config-activation.js";
import { createPluginManager } from "./components/plugins/manager.js";
import { createSystemHostConnectionManager } from "./components/system-host/manager.js";
import { createSystemHostSetupNotice } from "./components/system-host/setup-notice.js";
import { createConfigWorkspace } from "./components/config-workspace.js";
import { createLongTermMemorySetup } from "./components/long-term-memory-setup.js";
import { createLongTermMemoryManager } from "./components/long-term-memory/manager.js";
import { createLongTermMemoryController } from "./controllers/long-term-memory/controller.js";

export function createConfigurationFeature({
  dom,
  runtimeClient,
  selectedEnvironmentId,
  recordControlEvent,
  onConfigurationApplied = async () => {},
  onConfigurationSettled = () => true,
}) {
  let configWorkspace;
  let activation;
  let modelSetup;
  const longTermMemorySetup = createLongTermMemorySetup({
    getEnvironmentId: selectedEnvironmentId,
    loadStatus: (environmentId) =>
      runtimeClient.loadLongTermMemoryStatus(environmentId),
    discoverModels: (providerId, environmentId) =>
      runtimeClient.discoverLongTermMemoryModels({
        environmentId,
        providerId,
      }),
    enableMemory: (input, environmentId) =>
      runtimeClient.enableLongTermMemory({
        environmentId,
        ...input,
      }),
    disableMemory: (environmentId) =>
      runtimeClient.disableLongTermMemory(environmentId),
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

  let hostSetupNotice;
  const hostConnection = createSystemHostConnectionManager({
    loadConnection: () => runtimeClient.getSystemHostConnection(),
    downloadSetup: (platform) =>
      runtimeClient.downloadSystemHostSetup(platform),
    revokeConnection: () => runtimeClient.revokeSystemHostConnection(),
    supportsConnection: () => runtimeClient.supportsSystemHostConnection(),
    onChange: () => hostSetupNotice?.render(),
  });
  hostSetupNotice = createSystemHostSetupNotice({
    container: dom.chatPanel?.querySelector(".composer-dock"),
    conversationRegion: dom.messagesList,
    getConnectionState: () => hostConnection.state,
    supportsConnection: () => runtimeClient.supportsSystemHostConnection(),
    refreshConnection: () => hostConnection.load(true),
    onOpen: () => {
      dom.configWorkspaceButton?.click();
      if (dom.configWorkspacePanel?.hidden === false)
        configWorkspace.activateCategory("computer");
    },
  });

  configWorkspace = createConfigWorkspace({
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
    hostConnection,
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
