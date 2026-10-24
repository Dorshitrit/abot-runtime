import { canNavigateConversation } from "./conversation-navigation-intent.js";

/** Prepare the session and recovered draft before committing its workspace. */
export function createWorkspaceConversationOpener({ state, shell, openSession }) {
  return async (sessionId, options) => {
    if (!sessionId) return false;
    if (!canNavigateConversation(state)) {
      shell.showToast?.("Wait for the environment change to finish before opening a conversation.", "neutral");
      return false;
    }
    let navigationRevision = shell.navigationRevision?.();
    const sessionIdBefore = state.currentSessionId;
    const viewVersion = state.sessionViewVersion;
    const activate = await shell.prepareWorkspaceActivation("chat");
    if (!activate) return false;
    if (navigationRevision !== shell.navigationRevision?.()) return false;
    if (sessionIdBefore !== state.currentSessionId) return false;
    if (viewVersion !== state.sessionViewVersion) return false;
    function isConversationWorkspaceNavigationCurrent() {
      if (!canNavigateConversation(state)) return false;
      if (!committed && activate.canCommit?.() === false) return false;
      return shell.navigationRevision?.() === navigationRevision;
    }
    let committed = false;
    const opened = await openSession(sessionId, {
      ...options,
      isRouteCurrent: isConversationWorkspaceNavigationCurrent,
      commitRouteNavigation: () => {
        if (!isConversationWorkspaceNavigationCurrent()) return false;
        committed = activate() === true;
        navigationRevision = shell.navigationRevision?.();
        return committed;
      },
    });
    if (opened !== true) return false;
    if (!committed) return false;
    if (!isConversationWorkspaceNavigationCurrent()) return false;
    return state.currentSessionId === sessionId;
  };
}
