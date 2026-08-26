import { textOf } from "../lib/text-format.js";

const SETUP_MESSAGE =
  "Configure a provider and model, then restart the local services before starting a chat.";
const CHECKING_MESSAGE =
  "Checking model availability. Wait for the catalog refresh to finish.";
const ERROR_MESSAGE =
  "ABot could not check the model catalog. Verify the local services, then try again.";

function setupRequired(message = SETUP_MESSAGE) {
  return {
    status: "setup_required",
    code: "runtime_configuration_required",
    message: textOf(message, SETUP_MESSAGE),
    showGuide: true,
  };
}

function catalogError(error) {
  const message =
    error instanceof Error
      ? textOf(error.message, ERROR_MESSAGE)
      : ERROR_MESSAGE;
  return {
    status: "error",
    code: "model_catalog_unavailable",
    message,
    showGuide: true,
  };
}

function guideWasVisible(availability) {
  return (
    availability?.showGuide !== false &&
    ["checking", "error", "setup_required"].includes(availability?.status)
  );
}

export function createRuntimeOnboardingController({
  state,
  guide,
  reloadModels,
  setMessageStatus,
  onStateChange = () => {},
}) {
  let checkPromise = null;

  function bind() {
    guide.bind({ onCheckAgain: checkAgain });
    render();
  }

  function render() {
    guide.render(state.runtimeAvailability);
  }

  function beginCatalogLoad() {
    state.runtimeAvailability = {
      status: "checking",
      showGuide: guideWasVisible(state.runtimeAvailability),
    };
    render();
    onStateChange();
  }

  function applyCatalog(payload) {
    const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
    const availability = payload?.availability;
    const wasVisible = guideWasVisible(state.runtimeAvailability);
    const ready = availability?.status === "ready" && profiles.length > 0;
    state.runtimeAvailability = ready
      ? { status: "ready" }
      : setupRequired(availability?.message);
    render();
    onStateChange();
    if (ready && wasVisible) {
      setMessageStatus("Model ready. You can start chatting.");
    }
  }

  function catalogUnavailable(error) {
    state.runtimeAvailability = catalogError(error);
    render();
    onStateChange();
  }

  function checkAgain() {
    if (checkPromise || state.runtimeAvailability?.status === "checking") {
      return checkPromise || Promise.resolve();
    }
    const run = Promise.resolve()
      .then(() => reloadModels())
      .catch((error) => catalogUnavailable(error));
    checkPromise = run.finally(() => {
      checkPromise = null;
    });
    return checkPromise;
  }

  function isReady() {
    return state.runtimeAvailability?.status === "ready";
  }

  function submissionBlock() {
    if (isReady()) return null;
    const availability = state.runtimeAvailability;
    const message =
      availability?.status === "checking"
        ? CHECKING_MESSAGE
        : availability?.status === "error"
          ? textOf(availability.message, ERROR_MESSAGE)
          : textOf(availability?.message, SETUP_MESSAGE);
    return {
      code: "runtime_setup_required",
      message,
    };
  }

  function presentSubmissionBlock(block) {
    setMessageStatus(block?.message || SETUP_MESSAGE);
    guide.focusAction();
  }

  return {
    applyCatalog,
    beginCatalogLoad,
    bind,
    catalogUnavailable,
    isReady,
    presentSubmissionBlock,
    render,
    submissionBlock,
  };
}
