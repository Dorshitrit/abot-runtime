import { selectedModelProvider } from "./validation.js";
import {
  isDefinitiveModelSaveRejection,
  modelSaveFailureMessage,
} from "./save-outcome.js";

export function createModelSaveFlow({
  state,
  beginOperation,
  isCurrent,
  settleStaleOperation,
  readRequest,
  clearSecret,
  render,
  closeCompleted,
  saveModel,
  applySetup,
  beginRuntimeMutation,
  endRuntimeMutation,
  onSaved,
  onComplete,
}) {
  async function refreshModelList(operation) {
    state.busy = "refreshing";
    render();
    const refreshed = await onComplete(state.saved);
    if (!isCurrent(operation)) return false;
    if (refreshed === false) {
      state.error = "Model applied. Refresh the model list to continue.";
      return false;
    }
    return true;
  }

  async function finish() {
    if (state.busy) return false;
    if (!beginRuntimeMutation("model settings")) {
      state.error =
        "Save or reset configuration changes before adding a model.";
      render();
      return false;
    }
    const operation = beginOperation();
    let completed = false;
    try {
      state.error = "";
      if (!state.saved) {
        const input = readRequest();
        if (!input) return false;
        clearSecret();
        state.busy = "saving";
        render();
        let payload;
        try {
          payload = await saveModel(input);
        } finally {
          delete input.apiKey;
        }
        if (!isCurrent(operation)) return false;
        if (
          !payload?.model?.profileId ||
          !payload.model.providerId ||
          !payload.model.model
        )
          throw new Error("Saved model identity unavailable");
        state.saveOutcomeUncertain = false;
        state.saved = payload.model;
        onSaved(state.saved);
      }
      if (!state.applied) {
        state.busy = "applying";
        render();
        const payload = await applySetup();
        if (!isCurrent(operation)) return false;
        if (payload?.activation?.status === "restart_required") {
          state.error =
            payload.activation.message ||
            "Model saved. Apply it when your agent is idle.";
          return false;
        }
        if (payload?.activation?.status !== "ready")
          throw new Error("Model application unavailable");
        state.applied = true;
      }
      completed = await refreshModelList(operation);
    } catch (error) {
      if (!isCurrent(operation)) return false;
      if (state.busy === "saving")
        state.saveOutcomeUncertain = !isDefinitiveModelSaveRejection(error);
      const credentialSaved = error?.payload?.credentialSaved === true;
      if (credentialSaved)
        state.credentialSavedFor =
          selectedModelProvider(state)?.id || state.newProviderId;
      const fallback = modelSaveFailureMessage(state);
      state.error = error?.payload?.message || fallback;
      if (credentialSaved)
        state.error +=
          " Your API key was saved privately and will be reused on retry.";
    } finally {
      endRuntimeMutation();
      if (isCurrent(operation)) {
        state.busy = "";
        if (completed) closeCompleted();
        else render();
      } else settleStaleOperation(operation);
    }
    return completed;
  }

  return { finish };
}
