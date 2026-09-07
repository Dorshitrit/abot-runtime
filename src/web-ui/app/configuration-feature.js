import { createConfigWorkspace } from "./components/config-workspace.js";
import { createLongTermMemorySetup } from "./components/long-term-memory-setup.js";
import { createLongTermMemoryManager } from "./components/long-term-memory/manager.js";
import { createLongTermMemoryController } from "./controllers/long-term-memory/controller.js";

export function createConfigurationFeature({
  dom,
  runtimeClient,
  selectedEnvironmentId,
  recordControlEvent,
}) {
  let configWorkspace;
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

  configWorkspace = createConfigWorkspace({
    dom: {
      refreshConfigButton: dom.refreshConfigButton,
      configStatus: dom.configStatus,
      configDashboard: dom.configDashboard,
    },
    loadDashboard: () =>
      runtimeClient.loadConfigDashboard(selectedEnvironmentId()),
    saveFile: ({ kind, id, config }) =>
      runtimeClient.saveConfigFile({
        environmentId: selectedEnvironmentId(),
        kind,
        id,
        config,
      }),
    memorySetup: longTermMemorySetup,
    memoryManagement: {
      load: () => longTermMemoryController.load(),
      mount: (root) => longTermMemoryManager.mount(root),
    },
    recordControlEvent,
  });

  return configWorkspace;
}
