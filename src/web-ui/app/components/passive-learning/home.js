import { hostSetupIsReady } from "../system-host/rendering.js";
import { agentMarkup, renderAgent } from "./agent-view.js";
import { createAgentMotion } from "./agent-motion.js";
import { renderLearningProposals, handleProposalClick } from "./proposal-view.js";
import { learningFailurePresentation } from "./presentation.js";
import { homeActivityStartPatch, readActivityPermissions } from "./activity-controls.js";
import { computerUpdateNoticeMarkup, renderComputerUpdateNotice } from "./computer-update-notice.js";
import { macCollectionRestartNoticeMarkup, renderMacCollectionRestartNotice, handleMacCollectionRestartClick } from "./macos-collection-restart-notice.js";

function canStartHomeLearning(snapshot) {
  if (!homeActivityStartPatch(snapshot)) return false;
  if (snapshot.statusError || learningFailurePresentation(snapshot.status))
    return false;
  if (readActivityPermissions(snapshot.status.preferences).collection)
    return hostSetupIsReady(snapshot.hostConnection);
  return true;
}

function homeLearningActionLabel(snapshot) {
  if (hasIndependentHomeActivity(snapshot.status)) return "Open ABot Spark";
  return canStartHomeLearning(snapshot)
    ? "Start ABot Spark"
    : "Set up ABot Spark";
}

export function hasIndependentHomeActivity(status) {
  if (status?.preferences?.enabled) return true;
  if (status?.preferences?.proactiveEnabled) return true;
  if (status?.preferences?.modelProfileId && !status.preferences.processingPaused) return true;
  return Boolean(status?.processing);
}

export function createPassiveLearningHome({
  actions,
  openLearning,
  openSetup = openLearning,
  openComputerAccess = openSetup,
}) {
  let root = null;
  let renderedSnapshot = {};
  let motion;

  function mount(nextRoot) {
    if (root === nextRoot) return;
    motion?.dispose();
    root?.removeEventListener("click", handleClick);
    root = nextRoot;
    if (!root) return;
    root.innerHTML = `${computerUpdateNoticeMarkup()}${macCollectionRestartNoticeMarkup()}
    <div class="home-learning-agent">${agentMarkup({
      compact: true,
      actionMarkup: '<button type="button" class="home-text-button" data-learning-open>Open ABot Spark</button>',
    })}</div>
    <div class="co-worker-proposals" data-learning-proposals></div>
    <p class="home-learning-status" data-learning-status hidden></p>`;
    root.addEventListener("click", handleClick);
    motion = createAgentMotion(root);
  }

  function handleClick(event) {
    if (handleMacCollectionRestartClick(root, event, actions)) return;
    const update = event.target.closest("[data-learning-open-update]");
    if (update && root.contains(update)) {
      openComputerAccess();
      return;
    }
    if (handleProposalClick(root, event, actions)) return;
    const button = event.target.closest("[data-learning-open]");
    if (!button || !root.contains(button) || button.disabled) return;
    const snapshot = actions?.snapshot?.() ?? renderedSnapshot;
    if (snapshot.saving || snapshot.loadingStatus) return;
    if (hasIndependentHomeActivity(snapshot.status)) {
      openLearning();
      return;
    }
    if (!canStartHomeLearning(snapshot)) {
      openSetup();
      return;
    }
    void actions.configure(homeActivityStartPatch(snapshot));
  }

  function render(snapshot) {
    renderedSnapshot = snapshot;
    if (!root) return;
    renderComputerUpdateNotice(root, snapshot);
    renderMacCollectionRestartNotice(root, snapshot);
    renderAgent(root, snapshot);
    renderLearningProposals(root, snapshot, { limit: 1 });
    motion?.update(snapshot);
    root.hidden = false;
    const action = root.querySelector("[data-learning-open]");
    action.textContent = homeLearningActionLabel(snapshot);
    action.disabled = Boolean(snapshot.saving || snapshot.loadingStatus);
    const error = root.querySelector("[data-learning-status]");
    error.textContent = snapshot.statusError || "";
    error.hidden = !snapshot.statusError;
  }

  return Object.freeze({ mount, render });
}
