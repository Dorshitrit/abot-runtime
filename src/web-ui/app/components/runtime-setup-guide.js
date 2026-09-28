import { textOf } from "../lib/text-format.js";
import { renderRuntimeSetup } from "./runtime-setup/rendering.js";
import { createSetupOptionalSteps } from "./runtime-setup/optional-steps.js";
import { createSetupViewState } from "./runtime-setup/view-state.js";
import {
  preserveConfigurationRecovery,
  requiresConfigurationRecovery,
  renderConfigurationRecovery,
} from "./runtime-setup/configuration-recovery.js";
import {
  canEditSetupConnection,
  canContinueSavedConnection,
  hasSetupConnectionChanges,
  receiveSetupConnection,
  selectSetupProvider,
  setupConnectionSaveError,
  setupConnectionSubmitLabel,
  updateSetupConnectionField,
} from "./runtime-setup/connection-state.js";
import {
  clearConnectionSecret,
  readConnectionSecret,
  validateConnectionFields,
  showConnectionFieldError,
} from "./runtime-setup/connection-form.js";
import {
  DEFAULT_OLLAMA_BASE_URL,
  normalizeProvider,
} from "./runtime-setup/validation.js";

export { buildRuntimeSetupCommands } from "./runtime-setup/commands.js";
export {
  validateRuntimeSetupBaseUrl,
  validateRuntimeSetupModelId,
} from "./runtime-setup/validation.js";

export function createRuntimeSetupGuide({
  container,
  conversationRegion,
  loadSetup,
  saveSetup,
  applySetup,
  loadEmbeddingStatus,
  discoverEmbeddingModels,
  saveEmbedding,
  loadPlugins,
  setPlugin,
  loadHostConnection,
  connectLocalHost,
  createHostPairing,
  downloadHostSetup,
  revokeHostConnection,
  getEnvironmentId = () => "",
  openConfiguration = () => {},
}) {
  const state = {
    providers: [],
    provider: "",
    modelId: "",
    contextWindowTokens: "",
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
    step: 0,
    loading: false,
    saving: false,
    applying: false,
    loaded: false,
    loadFailed: false,
    error: "",
    activation: null,
    existingModel: null,
    editableConnection: null,
    finishAttempted: false,
  };
  let availability = { status: "loading" };
  let environmentId = getEnvironmentId();
  let revision = 0;
  let bound = false;
  let onCheckAgain = () => {};
  const viewState = createSetupViewState(container);
  const optionalSteps = createSetupOptionalSteps({
    container, getEnvironmentId, getPreferredProvider: () => state.provider,
    loadEmbeddingStatus, discoverEmbeddingModels, saveEmbedding, loadPlugins,
    setPlugin, loadHostConnection, connectLocalHost, createHostPairing, downloadHostSetup, revokeHostConnection,
    onChange: paint, goToStep,
  });
  const { embedding, plugins, readyStep } = optionalSteps;

  function goToStep(step) {
    state.step = step;
    state.error = "";
    paint({ focus: true });
    optionalSteps.load(step);
  }

  function clearSecret() {
    clearConnectionSecret(container);
    embedding.clearSecret();
  }

  function reset() {
    revision += 1;
    optionalSteps.reset();
    viewState.reset();
    clearSecret();
    Object.assign(state, {
      providers: [],
      provider: "",
      modelId: "",
      contextWindowTokens: "",
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
      step: 0,
      loading: false,
      saving: false,
      applying: false,
      loaded: false,
      loadFailed: false,
      error: "",
      activation: null,
      existingModel: null,
      editableConnection: null,
      finishAttempted: false,
    });
  }

  function operationIsCurrent(operationRevision, operationEnvironment) {
    if (operationRevision !== revision) return false;
    return operationEnvironment === getEnvironmentId();
  }

  function guideShouldBeVisible() {
    if (availability.showGuide === false) return false;
    return ["checking", "error", "setup_required"].includes(
      availability.status,
    );
  }

  function paint({ focus = false } = {}) {
    if (!guideShouldBeVisible()) return;
    if (requiresConfigurationRecovery(availability)) {
      clearSecret();
      container.innerHTML = renderConfigurationRecovery(availability);
      return;
    }
    viewState.capture();
    clearSecret();
    const optional = optionalSteps.projection(state.step);
    container.innerHTML = renderRuntimeSetup(state, availability, optional);
    optionalSteps.afterPaint(state.step, { restoreFocus: viewState.canRestoreFocus() });
    viewState.restore({ focus, busy: controlsAreBusy() });
  }

  async function loadOptions() {
    if (state.loading) return;
    const operationRevision = ++revision;
    const operationEnvironment = getEnvironmentId();
    state.loading = true;
    state.loadFailed = false;
    state.error = "";
    paint();
    try {
      const payload = await loadSetup();
      if (!operationIsCurrent(operationRevision, operationEnvironment)) return;
      if (requiresConfigurationRecovery(payload?.setup))
        availability = { ...availability, recovery: "configuration", message: payload.setup.message };
      state.providers = (payload?.setup?.providers || []).filter((provider) =>
        normalizeProvider(provider.id),
      );
      receiveSetupConnection(state, payload.setup);
      state.loaded = true;
    } catch {
      if (!operationIsCurrent(operationRevision, operationEnvironment)) return;
      state.loadFailed = true;
      state.error = "Could not load connection options. Try again.";
    } finally {
      if (operationIsCurrent(operationRevision, operationEnvironment)) {
        state.loading = false;
        paint();
        if (state.step === 2) void embedding.load();
      }
    }
  }

  function fieldError(field, message) {
    state.error = message;
    paint();
    showConnectionFieldError(container, field);
  }

  function connectionInput() {
    const result = validateConnectionFields({
      modelId: state.modelId,
      contextWindowTokens: state.contextWindowTokens,
      providerType: state.provider,
      baseUrl: state.baseUrl,
    });
    if (!result.valid) {
      fieldError(result.field, result.message);
      return null;
    }
    const input = { provider: state.provider, ...result.input };
    if (state.editableConnection?.revision)
      input.connectionRevision = state.editableConnection.revision;
    if (state.provider === "ollama") return input;
    const apiKey = readConnectionSecret(container);
    const provider = state.providers.find(
      (entry) => entry.id === state.provider,
    );
    if (provider?.credentialConfigured !== true && !apiKey) {
      fieldError("api-key", "Enter your OpenAI API key.");
      return null;
    }
    return apiKey ? { ...input, apiKey } : input;
  }

  async function submitConnection() {
    const input = connectionInput();
    if (!input) return;
    const connectionChanged = hasSetupConnectionChanges(state);
    const operationRevision = ++revision;
    const operationEnvironment = getEnvironmentId();
    state.saving = true;
    state.error = "";
    clearSecret();
    paint();
    try {
      const payload = await saveSetup({ ...input, deferActivation: true });
      if (!operationIsCurrent(operationRevision, operationEnvironment)) return;
      if (
        !["ready", "restart_required"].includes(payload?.activation?.status)
      ) {
        throw new Error("Setup activation unavailable");
      }
      state.activation = payload.activation;
      state.providers = payload.setup?.providers || state.providers;
      state.editableConnection = payload.setup?.editableConnection || null;
      state.existingModel = payload.setup?.existingModel || {
        provider: state.provider,
        model: state.modelId,
        contextWindowTokens: Number(state.contextWindowTokens),
        baseUrl: state.baseUrl,
      };
      if (connectionChanged || payload.embeddingInvalidated)
        embedding.invalidateConnection();
      state.finishAttempted = false;
      state.step = 2;
    } catch (error) {
      if (!operationIsCurrent(operationRevision, operationEnvironment)) return;
      state.error = setupConnectionSaveError(error);
    } finally {
      delete input.apiKey;
      if (operationIsCurrent(operationRevision, operationEnvironment)) {
        state.saving = false;
        paint({ focus: true });
        if (state.step === 2) void embedding.load();
      }
    }
  }

  async function applyConnection() {
    const operationRevision = ++revision;
    const operationEnvironment = getEnvironmentId();
    let activated = false;
    state.applying = true;
    state.finishAttempted = true;
    state.error = "";
    clearSecret();
    paint();
    try {
      const payload = await applySetup();
      if (!operationIsCurrent(operationRevision, operationEnvironment)) return;
      if (
        !["ready", "restart_required"].includes(payload?.activation?.status)
      ) {
        throw new Error("Setup activation unavailable");
      }
      state.activation = payload.activation;
      state.step = readyStep;
      if (state.activation.status === "ready") {
        activated = true;
        await onCheckAgain();
      }
    } catch {
      if (!operationIsCurrent(operationRevision, operationEnvironment)) return;
      state.error = activated
        ? "Connection applied. Check model availability again."
        : "Could not apply your saved connection. Try again when your agent is idle.";
    } finally {
      if (operationIsCurrent(operationRevision, operationEnvironment)) {
        state.applying = false;
        paint({ focus: true });
      }
    }
  }

  function controlsAreBusy() {
    if (requiresConfigurationRecovery(availability)) return true;
    if (
      state.loading ||
      state.saving ||
      state.applying ||
      embedding.state.busy ||
      plugins.state.busy
    )
      return true;
    return availability.status === "checking";
  }

  function submit(event) {
    event.preventDefault();
    if (controlsAreBusy()) return;
    if (state.step === 0) {
      if (!state.loaded || !state.provider) return;
      state.step = 1;
      state.error = "";
      paint({ focus: true });
      return;
    }
    if (state.step === 1) {
      const replacementKey = readConnectionSecret(container);
      if (canContinueSavedConnection(state, replacementKey)) goToStep(2);
      else void submitConnection();
      return;
    }
    if (state.step === 2) {
      void embedding.submit();
      return;
    }
    if (state.step === 3 && plugins.state.loaded && !plugins.state.error) {
      goToStep(4);
      return;
    }
    if (optionalSteps.canContinueComputer(state.step)) goToStep(readyStep);
  }

  function click(event) {
    const action = event.target.closest?.("[data-runtime-setup-action]")
      ?.dataset.runtimeSetupAction;
    if (requiresConfigurationRecovery(availability)) {
      if (availability.status === "checking") return;
      if (action === "configuration") openConfiguration();
      if (action === "check") void onCheckAgain();
      return;
    }
    if (!action || controlsAreBusy()) return;
    const setupWasApplied =
      state.finishAttempted && state.activation?.status === "ready";
    if (setupWasApplied && action !== "check") return;
    if (action === "apply" && state.step === readyStep) {
      void applyConnection();
      return;
    }
    if (
      action === "check" &&
      (state.step < 2 ||
        (state.activation?.status === "ready" && state.step === readyStep))
    ) {
      clearSecret();
      void onCheckAgain();
      return;
    }
    if (action === "reload") {
      void loadOptions();
      return;
    }
    if (action === "skip-embedding" && state.step === 2) {
      goToStep(3);
      return;
    }
    if (action === "skip-computer" && state.step === 4 && optionalSteps.hasComputerStep) {
      goToStep(readyStep);
      return;
    }
    if (action === "plugins-reload" && state.step === 3) {
      void plugins.load(true);
      return;
    }
    if (action.startsWith("embedding-") && state.step === 2) {
      embedding.click(action);
      return;
    }
    if (action === "back")
      goToStep(Math.max(canEditSetupConnection(state) ? 0 : 1, state.step - 1));
  }

  function input(event) {
    if (controlsAreBusy()) return;
    const field = event.target.closest?.("[data-runtime-setup-field]");
    if (!field) return;
    if (state.step === 2) {
      embedding.input(field.dataset.runtimeSetupField, textOf(field.value));
      return;
    }
    field.removeAttribute?.("aria-invalid");
    updateSetupConnectionField(
      state,
      field.dataset.runtimeSetupField,
      textOf(field.value),
    );
    const action = container.querySelector(
      '.runtime-setup-action[type="submit"]',
    );
    if (action)
      action.textContent = setupConnectionSubmitLabel(
        state,
        readConnectionSecret(container),
      );
  }

  function change(event) {
    if (controlsAreBusy()) return;
    const field = event.target.closest?.("[data-runtime-setup-field]");
    if (state.step === 2) {
      embedding.change(field?.dataset.runtimeSetupField, textOf(field?.value));
      return;
    }
    if (
      !canEditSetupConnection(state) ||
      field?.dataset.runtimeSetupField !== "provider"
    )
      return;
    selectSetupProvider(state, field.value);
    state.error = "";
    paint();
    container
      .querySelector(
        `[data-runtime-setup-field="provider"][value="${state.provider}"]`,
      )
      ?.focus?.({ preventScroll: true });
  }

  function bind({ onCheckAgain: checkAgain = () => {} } = {}) {
    onCheckAgain = checkAgain;
    if (bound) return;
    bound = true;
    container.addEventListener("submit", submit);
    container.addEventListener("click", click);
    container.addEventListener("input", input);
    container.addEventListener("change", change);
  }

  function render(setup) {
    const incoming = setup || { status: "loading" };
    availability = environmentId === getEnvironmentId()
      ? preserveConfigurationRecovery(availability, incoming)
      : incoming;
    if (requiresConfigurationRecovery(availability)) reset();
    if (environmentId !== getEnvironmentId()) {
      reset();
      environmentId = getEnvironmentId();
    }
    const visible = guideShouldBeVisible();
    container.hidden = !visible;
    conversationRegion.hidden = visible;
    if (!visible) {
      reset();
      container.replaceChildren();
      return;
    }
    paint();
    if (requiresConfigurationRecovery(availability)) return;
    if (!state.loaded && !state.loading && !state.loadFailed)
      void loadOptions();
  }

  function focusAction() {
    container.querySelector('[data-runtime-setup-action="check"]')?.focus?.();
  }

  function dispose() {
    reset();
    container.replaceChildren();
  }

  return { bind, clearSecret, dispose, focusAction, render };
}
