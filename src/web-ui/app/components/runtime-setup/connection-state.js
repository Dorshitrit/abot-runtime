import { setupPromptCacheState, updateSetupPromptCacheField } from "./prompt-cache-fields.js";
import { textOf } from "../../lib/text-format.js";
import { setupReasoningState, updateSetupReasoningField } from "./reasoning-fields.js";
import { normalizeProvider, defaultSetupProviderAddress } from "./validation.js";
import { readSetupContextWindowFeedback } from "./context-window-feedback.js";

export function selectSetupProvider(state, value) {
  const provider = normalizeProvider(value);
  const providerChanged = state.provider !== provider;
  if (providerChanged) {
    state.modelId = "";
    state.baseUrl = defaultSetupProviderAddress(provider);
    Object.assign(state, setupReasoningState(), setupPromptCacheState());
  }
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
  if (state.provider === "openai-chatgpt" && state.accountRef !== saved.accountRef) return true;
  if (state.modelId.trim() !== saved.model) return true;
  if (Number(state.contextWindowTokens) !== saved.contextWindowTokens)
    return true;
  if (state.supportsThinking !== saved.supportsThinking) return true;
  if (state.provider === "openai" && (state.promptCache === true) !== (saved.promptCache === true)) return true;
  if (state.provider === "llamacpp") {
    const reasoning = setupReasoningState(saved);
    if (state.supportsThinking !== reasoning.supportsThinking) return true;
    if (state.reasoningBudgetMode !== reasoning.reasoningBudgetMode) return true;
    if (state.reasoningBudgetTokens !== reasoning.reasoningBudgetTokens) return true;
  }
  if (!["ollama", "llamacpp"].includes(state.provider)) return false;
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

export function receiveSetupConnectionSaveError(state, error) {
  state.contextWindowFeedback = readSetupContextWindowFeedback(error);
  state.error = "";
  if (state.contextWindowFeedback) return;
  state.error = setupConnectionSaveError(error);
}

function setupConnectionSaveError(error) {
  if (error?.payload?.error === "setup_configuration_changed")
    return "Your connection changed in another window. Refresh this page before editing it again.";
  return "Could not save your connection. Check the model and connection details, then try again.";
}

export function updateSetupConnectionField(state, field, value) {
  if (!canEditSetupConnection(state)) return;
  if (field === "model-id") state.modelId = value;
  if (field === "context-window") state.contextWindowTokens = value;
  if (["ollama-base-url", "llamacpp-base-url"].includes(field)) state.baseUrl = value;
  if (updateSetupPromptCacheField(state, field, value)) return true;
  return updateSetupReasoningField(state, field, value);
}

export function receiveSetupConnection(state, setup) {
  state.editableConnection = setup?.editableConnection || null;
  state.existingModel = setup?.existingModel || null;
  Object.assign(state, setupReasoningState(state.existingModel || {}), setupPromptCacheState(state.existingModel || {}));
  state.contextWindowTokens = textOf(
    state.existingModel?.contextWindowTokens ??
      setup?.defaultContextWindowTokens,
  );
  if (!state.existingModel) return;
  state.provider = state.existingModel.provider;
  state.accountRef = state.existingModel.accountRef || "";
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
