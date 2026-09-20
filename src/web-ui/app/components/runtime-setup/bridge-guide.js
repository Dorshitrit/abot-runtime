import { textOf } from "../../lib/text-format.js";
import { renderBridgeSetup } from "./bridge-rendering.js";
import { buildBridgeSetupCommands } from "./commands.js";
import { createSetupViewState } from "./view-state.js";
import { showConnectionFieldError } from "./connection-form.js";
import { selectSetupProvider } from "./connection-state.js";
import {
  DEFAULT_OLLAMA_BASE_URL,
  validateRuntimeSetupBaseUrl,
  validateRuntimeSetupModelId,
} from "./validation.js";

export function createBridgeSetupGuide({
  container,
  conversationRegion,
  getEnvironmentId = () => "",
  getSetupCommandMode = () => "source",
  copyText = (value) => navigator.clipboard.writeText(value),
}) {
  const state = {
    provider: "",
    modelId: "",
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
    step: 0,
    error: "",
  };
  const viewState = createSetupViewState(container);
  let availability = { status: "loading" };
  let environmentId = getEnvironmentId();
  let revision = 0;
  let bound = false;
  let onCheckAgain = () => {};

  function reset() {
    revision += 1;
    Object.assign(state, {
      provider: "",
      modelId: "",
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
      step: 0,
      error: "",
    });
    viewState.reset();
  }

  function paint(focus = false) {
    viewState.capture();
    container.innerHTML = renderBridgeSetup(
      state,
      availability,
      getSetupCommandMode(),
    );
    viewState.restore({ focus, busy: availability.status === "checking" });
  }

  function showFieldError(field, message) {
    state.error = message;
    paint();
    showConnectionFieldError(container, field);
    return false;
  }

  function validateBridgeConnection() {
    if (!state.provider)
      return showFieldError("provider", "Choose a provider.");
    const model = validateRuntimeSetupModelId(state.modelId);
    if (!model.valid) return showFieldError("model-id", model.message);
    if (state.provider !== "ollama") return true;
    const address = validateRuntimeSetupBaseUrl(state.baseUrl);
    if (!address.valid)
      return showFieldError("ollama-base-url", address.message);
    return true;
  }

  async function copyCommand(commandId) {
    if (
      !["ollama-pull", "setup", "model-gateway", "web-ui"].includes(commandId)
    )
      return;
    if (!validateBridgeConnection()) return;
    const commands = buildBridgeSetupCommands(
      state.provider,
      state.modelId,
      state.baseUrl,
      getSetupCommandMode(),
    );
    if (!commands[commandId]) return;
    const operationRevision = revision;
    const operationEnvironment = getEnvironmentId();
    let message = "Copied";
    try {
      await copyText(commands[commandId]);
    } catch {
      message = "Could not copy";
    }
    const copyIsCurrent =
      operationRevision === revision &&
      operationEnvironment === getEnvironmentId();
    if (!copyIsCurrent) return;
    const status = container.querySelector(
      `[data-runtime-copy-status="${commandId}"]`,
    );
    if (status) status.textContent = message;
  }

  function submit(event) {
    event.preventDefault();
    if (availability.status === "checking" || state.step !== 0) return;
    if (!validateBridgeConnection()) return;
    state.step = 1;
    state.error = "";
    revision += 1;
    paint(true);
  }

  function click(event) {
    if (availability.status === "checking") return;
    const target = event.target.closest?.("[data-runtime-setup-action]");
    const action = target?.dataset.runtimeSetupAction;
    if (action === "check") void onCheckAgain();
    if (action === "copy" && state.step === 1)
      void copyCommand(target.dataset.runtimeCommand);
    if (action !== "back") return;
    state.step = 0;
    state.error = "";
    revision += 1;
    paint(true);
  }

  function change(event) {
    if (availability.status === "checking" || state.step !== 0) return;
    const field = event.target.closest?.("[data-runtime-setup-field]");
    if (field?.dataset.runtimeSetupField !== "provider") return;
    selectSetupProvider(state, field.value);
    state.error = "";
    revision += 1;
    paint();
    container
      .querySelector(
        `[data-runtime-setup-field="provider"][value="${state.provider}"]`,
      )
      ?.focus?.({ preventScroll: true });
  }

  function input(event) {
    if (availability.status === "checking" || state.step !== 0) return;
    const field = event.target.closest?.("[data-runtime-setup-field]");
    if (!field) return;
    if (field.dataset.runtimeSetupField === "model-id")
      state.modelId = textOf(field.value);
    if (field.dataset.runtimeSetupField === "ollama-base-url")
      state.baseUrl = textOf(field.value);
    field.removeAttribute?.("aria-invalid");
    revision += 1;
  }

  function bind({ onCheckAgain: checkAgain = () => {} } = {}) {
    onCheckAgain = checkAgain;
    if (bound) return;
    bound = true;
    container.addEventListener("submit", submit);
    container.addEventListener("click", click);
    container.addEventListener("change", change);
    container.addEventListener("input", input);
  }

  function render(setup) {
    availability = setup || { status: "loading" };
    if (environmentId !== getEnvironmentId()) {
      reset();
      environmentId = getEnvironmentId();
    }
    const visible =
      availability.showGuide !== false &&
      ["checking", "error", "setup_required"].includes(availability.status);
    container.hidden = !visible;
    conversationRegion.hidden = visible;
    if (!visible) {
      dispose();
      return;
    }
    paint();
  }

  function dispose() {
    reset();
    container.replaceChildren();
  }

  return {
    bind,
    render,
    dispose,
    clearSecret() {},
    focusAction: () =>
      container.querySelector('[data-runtime-setup-action="check"]')?.focus?.(),
  };
}
