import { textOf } from "../../lib/text-format.js";
import { normalizeProvider } from "./validation.js";

export function selectSetupProvider(state, value) {
  const provider = normalizeProvider(value);
  const providerChanged = state.provider !== provider;
  if (providerChanged) state.modelId = "";
  state.provider = provider;
}

export function canEditSetupConnection(state) {
  if (!state.existingModel) return true;
  return Boolean(state.editableConnection?.revision);
}

export function hasSetupConnectionChanges(state) {
  const saved = state.existingModel;
  if (!saved) return true;
  if (state.provider !== saved.provider) return true;
  if (state.modelId.trim() !== saved.model) return true;
  if (Number(state.contextWindowTokens) !== saved.contextWindowTokens)
    return true;
  if (state.provider !== "ollama") return false;
  return state.baseUrl.trim().replace(/\/$/u, "") !== saved.baseUrl;
}

export function canContinueSavedConnection(state, apiKey = "") {
  if (!state.existingModel || !state.activation || apiKey) return false;
  if (!canEditSetupConnection(state)) return true;
  return !hasSetupConnectionChanges(state);
}

export function setupConnectionSubmitLabel(state, apiKey = "") {
  return canContinueSavedConnection(state, apiKey)
    ? "Continue"
    : "Save connection";
}

export function setupConnectionSaveError(error) {
  if (error?.payload?.error === "setup_configuration_changed")
    return "Your connection changed in another window. Refresh this page before editing it again.";
  return "Could not save your connection. Check the model and connection details, then try again.";
}

export function updateSetupConnectionField(state, field, value) {
  if (!canEditSetupConnection(state)) return;
  if (field === "model-id") state.modelId = value;
  if (field === "context-window") state.contextWindowTokens = value;
  if (field === "ollama-base-url") state.baseUrl = value;
}

export function receiveSetupConnection(state, setup) {
  state.editableConnection = setup?.editableConnection || null;
  state.existingModel = setup?.existingModel || null;
  state.contextWindowTokens = textOf(
    state.existingModel?.contextWindowTokens ??
      setup?.defaultContextWindowTokens,
  );
  if (!state.existingModel) return;
  state.provider = state.existingModel.provider;
  state.modelId = state.existingModel.model;
  state.baseUrl = state.existingModel.baseUrl || state.baseUrl;
  state.step = 1;
  if (state.editableConnection) {
    state.activation = { status: "restart_required" };
    return;
  }
  if (setup.status !== "ready") return;
  state.activation = { status: "restart_required" };
  state.step = 2;
}
