/** Capture ordinary navigation before creating the handoff; never submit a user turn. */
export function createSparkHandoffNavigation({ state, getEnvironmentId, shell, conversation, onNavigationChange }) {
  return function captureNavigation() {
    const environmentId = getEnvironmentId();
    const sessionId = state.currentSessionId;
    const viewVersion = state.sessionViewVersion;
    const workspace = shell.activeWorkspace();
    let navigationRequest = shell.navigationRequestRevision?.();
    function navigationIsCurrent() {
      if (environmentId !== getEnvironmentId()) return false;
      if (navigationRequest !== shell.navigationRequestRevision?.()) return false;
      if (sessionId !== state.currentSessionId || viewVersion !== state.sessionViewVersion) return false;
      return workspace === shell.activeWorkspace();
    }
    return async function openHandoffSession(targetSessionId) {
      if (!targetSessionId || !navigationIsCurrent()) return false;
      await conversation.loadSessions();
      if (!navigationIsCurrent()) return false;
      const activate = await shell.prepareWorkspaceActivation("chat");
      if (!activate || activate.canCommit?.() === false) return false;
      navigationRequest = shell.navigationRequestRevision?.();
      if (!navigationIsCurrent()) return false;
      let committed = false;
      await conversation.openSession(targetSessionId, {
        isRouteCurrent: navigationIsCurrent,
        commitRouteNavigation() {
          if (!navigationIsCurrent()) return false;
          committed = activate() !== false;
          return committed;
        },
      });
      if (!committed || environmentId !== getEnvironmentId()) return false;
      if (state.currentSessionId !== targetSessionId) return false;
      onNavigationChange();
      return true;
    };
  };
}
