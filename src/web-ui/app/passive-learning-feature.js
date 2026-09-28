import { createMacCollectionConsent } from "./components/passive-learning/macos-collection-consent.js";
import { createPassiveLearningController } from "./controllers/passive-learning-controller.js";
import { createPassiveLearningHome } from "./components/passive-learning/home.js";
import { createPassiveLearningMemory } from "./components/passive-learning/memory.js";
import { selectLearningView } from "./components/passive-learning/workspace-view.js";
import { createProposalNotifications } from "./components/passive-learning/proposal-notifications.js";
import { visibleProposalSnapshot } from "./components/passive-learning/proposal-read-state.js";

export function createPassiveLearningFeature({
  client,
  getEnvironmentId,
  learningRoot,
  openLearning,
  showActivityMemories,
  openComputerAccess,
  openSession = () => {},
  activateChat = () => true,
  onChange = () => {},
}) {
  let home;
  let memory;
  let sessionSnapshot;
  let collectionConsent;
  function renderViews(snapshot) {
    collectionConsent?.update(snapshot);
    const visibleSnapshot = visibleProposalSnapshot(snapshot, sessionSnapshot);
    home?.render(visibleSnapshot);
    memory?.render(visibleSnapshot);
  }
  async function openConversation(sessionId, environmentId) {
    if (environmentId !== getEnvironmentId()) return false;
    if (activateChat() === false) return false;
    await openSession(sessionId);
    return true;
  }
  const controller = createPassiveLearningController({
    client,
    getEnvironmentId,
    openSession: openConversation,
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
    openComputerAccess,
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
  const notifications = createProposalNotifications({
    getEnvironmentId,
    openSession: openConversation,
  });
  return Object.freeze({
    ...actions,
    setWorkspace(workspace) {
      collectionConsent.cancel();
      controller.setWorkspace(workspace);
    },
    handleRealtime(message) {
      if (message?.type === "system-host.changed") collectionConsent.cancel();
      notifications.handleRealtime(message);
      controller.handleRealtime(message);
    },
    environmentChanged() {
      collectionConsent.cancel();
      sessionSnapshot = undefined;
      notifications.environmentChanged();
      controller.environmentChanged();
    },
    updateSessions(snapshot) {
      if (snapshot.environmentId !== getEnvironmentId()) return;
      sessionSnapshot = snapshot;
      renderViews(controller.snapshot());
    },
    mountHome: (root) => {
      home.mount(root);
      home.render(
        visibleProposalSnapshot(controller.snapshot(), sessionSnapshot),
      );
    },
  });
}
