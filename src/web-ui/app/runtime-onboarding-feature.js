import { createEmbeddingCredentialStatus } from "./components/runtime-setup/embedding-credential-status.js";
import { createRuntimeSetupGuide } from "./components/runtime-setup-guide.js";
import { createBridgeSetupGuide } from "./components/runtime-setup/bridge-guide.js";
import { createRuntimeOnboardingController } from "./controllers/runtime-onboarding-controller.js";

export function createRuntimeOnboardingFeature({
  dom,
  shell,
  runtimeClient,
  selectedEnvironmentId,
  state,
  reloadModels,
  reloadCatalog,
  setMessageStatus,
  onStateChange,
}) {
  const usesBridgeBackend = () => state.config?.backend === "bridge";
  let selectedGuide = null;
  let bindings = {};

  function createConfiguredGuide() {
    const common = {
      container: dom.runtimeSetupGuide,
      conversationRegion: dom.messagesList,
      getEnvironmentId: selectedEnvironmentId,
    };
    if (usesBridgeBackend())
      return createBridgeSetupGuide({
        ...common,
        getSetupCommandMode: () => state.config.setupCommandMode,
      });
    const embedding = createEmbeddingCredentialStatus({
      runtimeClient,
      getEnvironmentId: selectedEnvironmentId,
    });
    return createRuntimeSetupGuide({
      ...common,
      loadSetup: () => runtimeClient.getRuntimeSetup(),
      openConfiguration: () => dom.modelsWorkspaceButton?.click(),
      saveSetup: (input) => runtimeClient.saveRuntimeSetup(input),
      applySetup: () =>
        runtimeClient.applyRuntimeConfiguration(selectedEnvironmentId()),
      loadEmbeddingStatus: embedding.loadStatus,
      discoverEmbeddingModels: (providerId) =>
        runtimeClient.discoverLongTermMemoryModels({
          environmentId: selectedEnvironmentId(),
          providerId,
        }),
      saveEmbedding: embedding.saveEmbedding,
      loadPlugins: () => runtimeClient.getRuntimePlugins(),
      setPlugin: (input) => runtimeClient.setRuntimePlugin(input),
      loadHostConnection: () => runtimeClient.getSystemHostConnection(),
      connectLocalHost: () => runtimeClient.connectLocalSystemHost(),
      createHostPairing: () => runtimeClient.createSystemHostPairing(),
      downloadHostSetup: (platform) =>
        runtimeClient.downloadSystemHostSetup(platform),
      revokeHostConnection: () => runtimeClient.revokeSystemHostConnection(),
    });
  }

  // Bootstrap binds controls before /web-config supplies the backend identity.
  const guide = {
    bind(options = {}) {
      bindings = options;
      selectedGuide?.bind(options);
    },
    render(availability) {
      shell?.runtimeAvailabilityChanged(availability);
      const hasConfiguredBackend = ["runtime", "bridge"].includes(
        state.config?.backend,
      );
      if (!hasConfiguredBackend) {
        dom.runtimeSetupGuide.hidden = true;
        dom.messagesList.hidden = false;
        return;
      }
      if (!selectedGuide) {
        selectedGuide = createConfiguredGuide();
        selectedGuide.bind(bindings);
      }
      selectedGuide.render(availability);
    },
    clearSecret: () => selectedGuide?.clearSecret(),
    dispose: () => selectedGuide?.dispose(),
    focusAction: () => selectedGuide?.focusAction(),
  };
  const controller = createRuntimeOnboardingController({
    state,
    guide,
    reloadModels: () =>
      usesBridgeBackend() ? reloadCatalog() : reloadModels(),
    setMessageStatus,
    onStateChange,
  });
  return { guide, controller };
}
