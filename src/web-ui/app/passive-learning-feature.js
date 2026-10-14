import { createMacCollectionConsent } from "./components/passive-learning/macos-collection-consent.js";
import { createCollectionConsentGate } from "./components/passive-learning/collection-consent-gate.js";
import { createPassiveLearningController } from "./controllers/passive-learning-controller.js";
import { createPassiveLearningHome } from "./components/passive-learning/home.js";
import { createPassiveLearningMemory } from "./components/passive-learning/memory.js";
import { selectLearningView } from "./components/passive-learning/workspace-view.js";

export function createPassiveLearningFeature({
  client,
  getEnvironmentId,
  learningRoot,
  openLearning,
  showActivityMemories,
  openComputerAccess,
  onChange = () => {},
  isRuntimeReady = () => true,
}) {
  let home;
  let memory;
  let collectionConsent;
  let macConsent;
  function renderViews(snapshot) {
    collectionConsent?.update(snapshot);
    macConsent?.update(snapshot);
    home?.render(snapshot);
    memory?.render(snapshot);
  }
  const controller = createPassiveLearningController({
    client,
    getEnvironmentId,
    isRuntimeReady,
    render: (snapshot) => {
      renderViews(snapshot);
      onChange();
    },
  });
  macConsent = createMacCollectionConsent({
    actions: controller,
    container: learningRoot,
  });
  collectionConsent = createCollectionConsentGate({
    actions: { ...controller, configure: macConsent.configure },
    container: learningRoot, openComputerAccess,
  });
  const actions = { ...controller, configure: collectionConsent.configure,
    restartCollection: collectionConsent.restartCollection };
  home = createPassiveLearningHome({
    actions,
    openLearning,
    openSetup: () => {
      if (openLearning() === false) return;
      if (learningRoot) selectLearningView(learningRoot, "settings");
    },
  });
  memory = createPassiveLearningMemory({
    actions,
    showActivityMemories,
    openComputerAccess,
  });
  memory.mount(learningRoot);
  return Object.freeze({
    ...actions,
    setWorkspace(workspace) {
      collectionConsent.cancel();
      macConsent.cancel();
      controller.setWorkspace(workspace);
    },
    handleRealtime(message) {
      if (message?.type === "system-host.changed") {
        collectionConsent.cancel();
        macConsent.cancel();
      }
      controller.handleRealtime(message);
    },
    environmentChanged() {
      collectionConsent.cancel();
      macConsent.cancel();
      controller.environmentChanged();
    },
    mountHome: (root, onRendered) => {
      home.mount(root, onRendered);
      home.render(controller.snapshot());
    },
  });
}
