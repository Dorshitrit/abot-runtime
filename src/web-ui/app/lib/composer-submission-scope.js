export function captureComposerSubmissionScope(state, environmentId) {
  return {
    environmentId,
    sessionId: state.currentSessionId,
    viewVersion: state.sessionViewVersion,
  };
}

export function isCurrentComposerSubmissionScope(scope, state, environmentId) {
  if (scope.environmentId !== environmentId) return false;
  if (scope.sessionId !== state.currentSessionId) return false;
  return scope.viewVersion === state.sessionViewVersion;
}
