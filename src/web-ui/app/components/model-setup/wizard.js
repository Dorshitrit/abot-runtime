import { textOf } from "../../lib/text-format.js";
import {
  clearConnectionSecret,
  readConnectionSecret,
  showConnectionFieldError,
} from "../runtime-setup/connection-form.js";
import { renderWizardProgress } from "../runtime-setup/wizard-shell.js";
import { DEFAULT_OLLAMA_BASE_URL } from "../runtime-setup/validation.js";
import { createSetupViewState } from "../runtime-setup/view-state.js";
import { createModelSaveFlow } from "./save-flow.js";
import {
  MODEL_SETUP_ID,
  MODEL_SETUP_STEPS,
  modelSetupFooter,
  modelSetupMarkup,
  modelSetupTitles,
  renderModelFields,
  renderModelProviderChoices,
  renderModelReview,
} from "./rendering.js";
import {
  modelSetupInput,
  requiresModelSaveCredential,
  selectedModelProvider,
  suggestIdentifier,
  validateModelDraft,
} from "./validation.js";

export function createModelSetupWizard({
  root,
  getEnvironmentId = () => "",
  loadSetup,
  saveModel,
  applySetup,
  beginRuntimeMutation = () => true,
  endRuntimeMutation = () => {},
  onSaved = () => {},
  onDeferred = async () => true,
  onComplete = async () => true,
  onClosed = () => {},
}) {
  const dialog = root.ownerDocument.createElement("dialog");
  dialog.className = "model-setup-dialog";
  dialog.setAttribute("aria-labelledby", `${MODEL_SETUP_ID}Title`);
  root.append(dialog);
  const state = {};
  const viewState = createSetupViewState(dialog);
  let generation = 0;
  let modelForm = null;
  let formChoice = "";
  let requestedProviderId = "";
  const beginOperation = () => ({
    generation: ++generation,
    environment: getEnvironmentId(),
  });
  const isCurrent = (operation) =>
    operation.generation === generation &&
    operation.environment === getEnvironmentId() &&
    dialog.open;
  const clearSecret = () => {
    if (modelForm) clearConnectionSecret(modelForm);
  };

  function reset() {
    clearSecret();
    viewState.reset();
    Object.assign(state, {
      providers: [],
      profileIds: [],
      choice: "",
      model: "",
      contextWindowTokens: "",
      profileId: "",
      profileEdited: false,
      newProviderId: "",
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
      step: 0,
      loaded: false,
      busy: "",
      error: "",
      notice: "",
      saved: null,
      applied: false,
      credentialSavedFor: "",
      saveOutcomeUncertain: false,
    });
    modelForm = null;
    formChoice = "";
  }

  function close(completed = false) {
    if (state.busy) return false;
    const wasOpen = dialog.open;
    generation += 1;
    clearSecret();
    state.saveOutcomeUncertain = false;
    dialog.close();
    dialog.replaceChildren();
    modelForm = null;
    if (wasOpen) onClosed({ completed });
    return true;
  }

  function showFieldError(result) {
    state.step = 1;
    state.error = result.message;
    render();
    showConnectionFieldError(
      modelForm,
      result.field,
      `${MODEL_SETUP_ID}Error`,
      MODEL_SETUP_ID,
    );
  }

  function readRequest() {
    const result = validateModelDraft(state);
    if (!result.valid) {
      clearSecret();
      showFieldError(result);
      return null;
    }
    const apiKey = readConnectionSecret(modelForm);
    if (requiresModelSaveCredential(state) && !apiKey) {
      showFieldError({
        field: "api-key",
        message: "Enter an API key for this connection.",
      });
      return null;
    }
    return modelSetupInput(state, result, apiKey);
  }

  const settleStaleOperation = (operation) => {
    if (
      operation.generation === generation &&
      operation.environment !== getEnvironmentId()
    ) {
      state.busy = "";
      close();
    }
  };

  const flow = createModelSaveFlow({
    state,
    beginOperation,
    isCurrent,
    settleStaleOperation,
    readRequest,
    clearSecret,
    render,
    closeCompleted: () => close(true),
    saveModel,
    applySetup,
    beginRuntimeMutation,
    endRuntimeMutation,
    onSaved,
    onDeferred,
    onComplete,
  });

  function render({ focus = false } = {}) {
    if (!dialog.open) return;
    viewState.capture();
    const title = dialog.querySelector("[data-runtime-setup-title]");
    title.textContent = modelSetupTitles(state)[state.step];
    dialog.querySelector("[data-wizard-progress]").innerHTML =
      renderWizardProgress(MODEL_SETUP_STEPS, state.step);
    dialog.querySelector("[data-wizard-mobile-progress]").textContent =
      `Step ${state.step + 1} of 3 · ${MODEL_SETUP_STEPS[state.step]}`;
    const providers = dialog.querySelector("[data-model-providers]");
    providers.hidden = state.step !== 0;
    providers.inert = Boolean(state.busy);
    if (state.step === 0)
      providers.innerHTML = renderModelProviderChoices(state);
    if (state.choice && formChoice !== state.choice) {
      clearSecret();
      modelForm.innerHTML = renderModelFields(state);
      formChoice = state.choice;
    }
    modelForm.hidden = state.step !== 1;
    modelForm.inert = state.step !== 1 || Boolean(state.busy);
    const key = modelForm.querySelector('[data-runtime-setup-field="api-key"]');
    if (key) key.required = requiresModelSaveCredential(state);
    const review = dialog.querySelector("[data-model-review]");
    review.hidden = state.step !== 2;
    if (state.step === 2) review.innerHTML = renderModelReview(state);
    const feedback = dialog.querySelector("[data-model-feedback]");
    feedback.textContent =
      state.error ||
      state.notice ||
      (state.busy
        ? `${state.busy === "saving" ? "Saving model" : state.busy === "applying" ? "Applying model" : state.busy === "refreshing" ? "Refreshing model list" : "Loading providers"}…`
        : "");
    feedback.setAttribute("role", state.error ? "alert" : "status");
    dialog.querySelector('[data-model-action="reload"]').hidden =
      state.loaded || !state.error;
    dialog.querySelector("[data-wizard-footer]").innerHTML =
      modelSetupFooter(state);
    dialog
      .querySelector(".runtime-setup-panel")
      .setAttribute("aria-busy", Boolean(state.busy).toString());
    viewState.restore({ focus, busy: Boolean(state.busy) });
  }

  async function load() {
    const operation = beginOperation();
    state.busy = "loading";
    state.error = "";
    render();
    try {
      const payload = await loadSetup();
      if (!isCurrent(operation)) return false;
      state.providers = Array.isArray(payload.providers)
        ? payload.providers
        : [];
      state.contextWindowTokens = textOf(payload.defaultContextWindowTokens);
      state.profileIds = Array.isArray(payload.profileIds)
        ? payload.profileIds
        : [];
      if (requestedProviderId) {
        const provider = state.providers.find(
          (entry) => entry.id === requestedProviderId,
        );
        if (provider) {
          state.choice = `existing:${provider.id}`;
          state.step = 1;
        } else
          state.error =
            "That provider is unavailable. Choose another connection.";
      }
      state.loaded = true;
      return true;
    } catch {
      if (isCurrent(operation))
        state.error = "Could not load provider connections. Try again.";
      return false;
    } finally {
      if (isCurrent(operation)) {
        state.busy = "";
        render({ focus: true });
      } else settleStaleOperation(operation);
    }
  }

  async function open({ providerId } = {}) {
    if (dialog.open) return false;
    reset();
    requestedProviderId = providerId || "";
    dialog.innerHTML = modelSetupMarkup(state);
    modelForm = dialog.querySelector("[data-model-form]");
    dialog.showModal();
    return load();
  }

  function next() {
    if (state.busy || !state.loaded) return;
    if (state.step === 0 && state.choice) {
      state.step = 1;
      state.error = "";
      render({ focus: true });
      return;
    }
    if (state.step !== 1) return;
    const result = validateModelDraft(state);
    if (!result.valid) {
      showFieldError(result);
      return;
    }
    if (!modelForm.reportValidity()) return;
    state.step = 2;
    state.error = "";
    render({ focus: true });
  }

  function input(event) {
    if (state.busy || state.saved || state.step !== 1) return;
    const field = event.target.dataset.runtimeSetupField;
    if (field === "api-key") {
      event.target.removeAttribute("aria-invalid");
      return;
    }
    state.saveOutcomeUncertain = false;
    const value = textOf(event.target.value);
    if (field === "model-id") {
      state.model = value;
      if (!state.profileEdited) {
        state.profileId = value
          ? suggestIdentifier(value, state.profileIds)
          : "";
        modelForm.querySelector(
          '[data-runtime-setup-field="profile-id"]',
        ).value = state.profileId;
      }
    }
    if (field === "context-window") state.contextWindowTokens = value;
    if (field === "profile-id") {
      state.profileId = value;
      state.profileEdited = true;
    }
    if (field === "connection-id") state.newProviderId = value;
    if (field === "ollama-base-url") state.baseUrl = value;
    const key = modelForm.querySelector('[data-runtime-setup-field="api-key"]');
    if (key) key.required = requiresModelSaveCredential(state);
    event.target.removeAttribute("aria-invalid");
  }

  dialog.addEventListener("input", input);
  dialog.addEventListener("change", (event) => {
    if (
      state.busy ||
      state.saved ||
      state.step !== 0 ||
      event.target.dataset.runtimeSetupField !== "provider"
    )
      return;
    clearSecret();
    state.saveOutcomeUncertain = false;
    const providerChanged = state.choice !== event.target.value;
    if (providerChanged) state.model = "";
    const resetSuggestedProfile = providerChanged && !state.profileEdited;
    if (resetSuggestedProfile) state.profileId = "";
    state.choice = event.target.value;
    state.newProviderId = selectedModelProvider(state)
      ? ""
      : suggestIdentifier(
          state.choice.replace("new:", ""),
          state.providers.map((entry) => entry.id),
          "provider",
        );
    state.error = "";
    render();
    Array.from(dialog.querySelectorAll('[data-runtime-setup-field="provider"]'))
      .find((entry) => entry.value === state.choice)
      ?.focus({ preventScroll: true });
  });
  dialog.addEventListener("submit", (event) => {
    event.preventDefault();
    next();
  });
  dialog.addEventListener("click", (event) => {
    const action = event.target.closest?.("[data-model-action]")?.dataset
      .modelAction;
    if (!action || state.busy) return;
    if (action === "cancel") close();
    if (action === "reload") void load();
    if (action === "next") next();
    if (action === "finish" && state.step === 2) void flow.finish();
    if (action === "back" && !state.saved) {
      if (state.step === 1) clearSecret();
      state.step = Math.max(0, state.step - 1);
      state.error = "";
      render({ focus: true });
    }
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!state.busy) close();
  });

  return {
    open,
    close: () => close(),
    isOpen: () => dialog.open,
    isBusy: () => Boolean(state.busy),
    dispose: () => {
      generation += 1;
      clearSecret();
      state.saveOutcomeUncertain = false;
      dialog.close();
      dialog.remove();
    },
  };
}
