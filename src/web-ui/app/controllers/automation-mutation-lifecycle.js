/** Keep the busy lock through settlement; obsolete views receive no result feedback. */
export function createAutomationMutationRunner({ state, publish, errorLabel, onStart,
  captureCurrentView = () => () => true }) {
  let activeInvocation;
  return async function mutation(label, operation, successFeedback = `${label} saved.`, isCurrent = () => true) {
    if (state.mutation) return false;
    const invocation = {};
    activeInvocation = invocation;
    const isCurrentView = captureCurrentView();
    const ownsMutationInvocation = () => activeInvocation === invocation;
    const canPublishMutationOutcome = () => ownsMutationInvocation() && isCurrentView() && isCurrent();
    onStart();
    state.mutation = label;
    state.error = "";
    publish();
    try {
      const value = await operation();
      if (!canPublishMutationOutcome()) return false;
      state.feedback = successFeedback;
      return value;
    } catch (error) {
      if (canPublishMutationOutcome()) state.error = errorLabel(error);
      return false;
    } finally {
      if (ownsMutationInvocation()) {
        activeInvocation = undefined;
        state.mutation = "";
        publish();
      }
    }
  };
}
