import { createEmbeddingSetupStep } from "./embedding.js";
import { createSetupPluginStep } from "./plugins.js";
import { createSystemHostConnectionManager } from "../system-host/manager.js";
import { hostSetupIsReady } from "../system-host/rendering.js";
import { isNativeWindowsLocalAccess } from "../system-host/native-windows-access.js";

/** Optional setup steps retain their owning services and never apply the Runtime. */
export function createSetupOptionalSteps({
  container,
  getEnvironmentId,
  getPreferredProvider,
  loadEmbeddingStatus,
  discoverEmbeddingModels,
  saveEmbedding,
  loadPlugins,
  setPlugin,
  loadHostConnection,
  connectLocalHost,
  createHostPairing,
  requestHostStoreConnection,
  requestHostPermissions,
  downloadHostSetup,
  revokeHostConnection,
  onChange,
  goToStep,
}) {
  const embedding = createEmbeddingSetupStep({
    container,
    getEnvironmentId,
    getPreferredProvider,
    loadStatus: loadEmbeddingStatus,
    discoverModels: discoverEmbeddingModels,
    saveEmbedding,
    onChange,
    onComplete: () => {
      plugins.reset();
      goToStep(3);
    },
  });
  const plugins = createSetupPluginStep({
    container,
    getEnvironmentId,
    loadPlugins,
    setPlugin,
    onChange,
  });
  const computer = loadHostConnection
    ? createSystemHostConnectionManager({
        getEnvironmentId,
        loadConnection: loadHostConnection,
        connectLocal: connectLocalHost,
        createPairing: createHostPairing,
        requestStoreConnection: requestHostStoreConnection,
        requestPermissions: requestHostPermissions,
        downloadSetup: downloadHostSetup,
        revokeConnection: revokeHostConnection,
        onChange,
      })
    : null;
  const readyStep = computer ? 5 : 4;
  function hasFreshComputerSetup() {
    if (!computer) return false;
    if (computer.state.busy || computer.state.statusUnavailable) return false;
    if (isNativeWindowsLocalAccess(computer.state.snapshot)) return true;
    return hostSetupIsReady(computer.state.snapshot);
  }
  function projection(step) {
    const common = {
      busy: embedding.state.busy || plugins.state.busy,
      content: "",
      canContinue: true,
      memory: embedding.state.status,
      plugins: plugins.state.snapshot,
      hasComputerStep: Boolean(computer),
      readyStep,
      computer: hasFreshComputerSetup() ? computer.state.snapshot : null,
      nativeWindowsAccess: hasFreshComputerSetup() && isNativeWindowsLocalAccess(computer.state.snapshot),
    };
    if (step === 2)
      return {
        ...common,
        content: embedding.markup(),
        canContinue: embedding.state.loaded,
        primaryLabel: embedding.primaryLabel(),
      };
    if (step === 3)
      return {
        ...common,
        content: plugins.markup(),
        canContinue: plugins.state.loaded && !plugins.state.error,
      };
    if (step === 4 && computer)
      return {
        ...common,
        content: `<div data-onboarding-computer>${computer.markup()}</div>`,
        canContinue: hasFreshComputerSetup(),
      };
    return common;
  }
  function load(step) {
    computer?.setActive(step === 4);
    if (step === 2) void embedding.load();
    if (step === 3) void plugins.load();
  }
  function afterPaint(step, options) {
    if (step === 3) plugins.afterPaint(options);
    if (step === 4)
      computer?.mount(container.querySelector("[data-onboarding-computer]"));
  }
  function reset() {
    embedding.reset();
    plugins.reset();
    computer?.reset();
  }
  function canContinueComputer(step) {
    if (step !== 4) return false;
    return hasFreshComputerSetup();
  }
  return {
    embedding,
    plugins,
    readyStep,
    projection,
    load,
    afterPaint,
    reset,
    canContinueComputer,
    hasComputerStep: Boolean(computer),
    hide: () => computer?.setActive(false),
    dispose: () => computer?.dispose(),
  };
}
