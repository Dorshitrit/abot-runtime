/** Capture user navigation intent separately from its eventual loaded selection. */
export function createAutomationViewCapture({ state, getEnvironmentId,
  getNavigationRevision, getNavigationRequestRevision, getMutationRevision }) {
  return function captureView() {
    const automationId = state.selectedAutomationId, runId = state.selectedRunId;
    const environmentId = getEnvironmentId();
    const navigationRevision = getNavigationRevision();
    const intentRevision = getNavigationRequestRevision();
    const isCurrent = () => environmentId === getEnvironmentId() &&
      navigationRevision === getNavigationRevision() && intentRevision === getNavigationRequestRevision() &&
      automationId === state.selectedAutomationId && runId === state.selectedRunId;
    function captureContinuation() {
      const mutationRevision = getMutationRevision();
      const ownsMutation = () => mutationRevision === getMutationRevision();
      return { ownsMutation, isCurrent: () => isCurrent() && ownsMutation() };
    }
    return { automationId, runId, environmentId, isCurrent, captureContinuation };
  };
}
