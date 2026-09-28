/** Only a canonical client-error response proves that this save was rejected. */
export function isDefinitiveModelSaveRejection(error) {
  if (!Number.isInteger(error?.status)) return false;
  if (error.status < 400) return false;
  if (error.status >= 500) return false;
  return typeof error.payload?.error === "string";
}

export function modelSaveFailureMessage(state) {
  if (state.applied) return "Model applied. Could not refresh the model list.";
  if (state.saved && state.busy === "refreshing")
    return "Model saved. It is not active yet. Could not refresh the model list.";
  if (state.saved)
    return "Model saved. Could not apply the configuration. Try again when your agent is idle.";
  if (state.saveOutcomeUncertain)
    return "The model save could not be confirmed. Try again to check the saved model and apply it.";
  return "Could not save this model. Check the connection details and try again.";
}

export function modelSaveErrorMessage(state, error) {
  const fallback = modelSaveFailureMessage(state);
  const detail = error?.payload?.message;
  if (!detail) return fallback;
  if (state.saved) return `${fallback} ${detail}`;
  return detail;
}

export function deferredModelMessage(activation) {
  const status = "Model saved. It is not active yet.";
  if (!activation.message) return `${status} Apply it when your agent is idle.`;
  return `${status} ${activation.message}`;
}
