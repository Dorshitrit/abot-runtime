import { canNavigateConversation } from "./conversation-navigation-intent.js";

/** Navigation commits only after the recovered draft is saved for the same view. */
export function createConversationWorkspaceActivation({ state, shell, composerQueue, selectedEnvironmentId }) {
  return async () => {
    if (!canNavigateConversation(state)) {
      shell.showToast?.("Wait for the environment change to finish before opening a conversation.", "neutral");
      return false;
    }
    const environment = selectedEnvironmentId();
    const session = state.currentSessionId;
    const version = state.sessionViewVersion;
    const navigationRevision = shell.navigationRevision?.();
    const recovery = await composerQueue.prepareRecoveryForNavigation();
    if (!recovery || recovery.canCommit?.() === false) return false;
    if (!canNavigateConversation(state)) return false;
    const hasCurrentWorkspaceNavigation = navigationRevision === shell.navigationRevision?.();
    if (!hasCurrentWorkspaceNavigation) return false;
    if (environment !== selectedEnvironmentId()) return false;
    if (session !== state.currentSessionId) return false;
    if (version !== state.sessionViewVersion) return false;
    const activate = shell.prepareWorkspaceActivation("chat", { focus: false });
    if (!activate) return false;
    recovery();
    return activate() !== false;
  };
}
