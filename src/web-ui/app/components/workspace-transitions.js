import { normalizeWorkspaceDestination } from "../ui-behavior.js";

export function createWorkspaceTransitions({ getWorkspace, getNavigationRevision, isAvailable, getGuards }) {
  let requestRevision = 0;
  async function prepare(destination) {
    const request = ++requestRevision;
    const from = getWorkspace();
    const revision = getNavigationRevision();
    const nextWorkspace = normalizeWorkspaceDestination(destination);
    const changes = [];
    function isCurrentTransitionRequest() {
      if (request !== requestRevision) return false;
      if (from !== getWorkspace()) return false;
      if (revision !== getNavigationRevision()) return false;
      return isAvailable(nextWorkspace);
    }
    function canCommitTransition() {
      if (!isCurrentTransitionRequest()) return false;
      return changes.every((change) => change?.canCommit?.() !== false);
    }
    if (!isCurrentTransitionRequest()) return null;
    const guards = nextWorkspace === from ? [] : getGuards();
    for (const guard of guards) {
      const change = await guard({ from, to: nextWorkspace });
      if (!canCommitTransition()) return null;
      if (change === false || change === null) return null;
      changes.push(change);
    }
    if (!canCommitTransition()) return null;
    return {
      nextWorkspace, canCommit: canCommitTransition,
      commitBeforeChange() {
        if (!canCommitTransition()) return false;
        for (const change of changes) {
          if (typeof change === "function" && change() === false) return false;
        }
        return true;
      },
    };
  }
  return { prepare, requestRevision: () => requestRevision };
}
