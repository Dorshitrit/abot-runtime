import { createMacCollectionConsent } from "./components/passive-learning/macos-collection-consent.js";
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
  function renderViews(snapshot) {
    collectionConsent?.update(snapshot);
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
  collectionConsent = createMacCollectionConsent({
    actions: controller,
    container: learningRoot,
  });
  const actions = { ...controller, configure: collectionConsent.configure };
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
      controller.setWorkspace(workspace);
    },
    handleRealtime(message) {
      if (message?.type === "system-host.changed") collectionConsent.cancel();
      controller.handleRealtime(message);
    },
    environmentChanged() {
      collectionConsent.cancel();
      controller.environmentChanged();
    },
    mountHome: (root) => {
      home.mount(root);
      home.render(controller.snapshot());
    },
  });
}
