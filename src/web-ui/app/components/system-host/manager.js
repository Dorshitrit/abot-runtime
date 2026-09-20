import { downloadHostSetup } from "./download.js";
import { hostSetupIsReady, renderSystemHostConnection } from "./rendering.js";
import { createSystemHostVisibility } from "./visibility.js";

export function createSystemHostConnectionManager({
  loadConnection,
  downloadSetup,
  revokeConnection,
  supportsConnection = () => true,
  saveDownload = downloadHostSetup,
  documentRoot = globalThis.document,
  onChange = () => {},
  schedulePoll = (callback, delay) => setTimeout(callback, delay),
  cancelPoll = (timer) => clearTimeout(timer),
}) {
  const state = {
    root: null,
    snapshot: null,
    active: false,
    busy: false,
    error: "",
    actionError: "",
    message: "",
    statusUnavailable: false,
    downloaded: null,
  };
  let revision = 0;
  let pollTimer;
  let wasVisible = false;
  let surfaceRevision = 0;
  let backgroundPending = false;
  let lastNotification = "";
  const visibility = createSystemHostVisibility({
    documentRoot,
    getRoot: () => state.root,
    isActive: () => state.active,
    onChange: visibilityChanged,
  });
  function markup() {
    return renderSystemHostConnection({
      ...state,
      error: state.error || state.actionError,
      supported: supportsConnection(),
    });
  }
  function afterPaint(root = state.root) {
    root
      ?.querySelector("[data-system-host-refresh]")
      ?.addEventListener("click", () => void load());
    root
      ?.querySelector("[data-system-host-revoke]")
      ?.addEventListener("click", () => void revoke());
    for (const button of root?.querySelectorAll?.(
      "[data-system-host-install]",
    ) || []) {
      button.addEventListener(
        "click",
        () => void install(button.dataset.systemHostInstall),
      );
    }
  }
  function render() {
    if (!state.root) return;
    state.root.innerHTML = markup();
    afterPaint();
  }
  function notify() {
    const content = markup();
    if (content === lastNotification) return;
    lastNotification = content;
    render();
    onChange();
  }
  function stopPolling() {
    if (pollTimer !== undefined) cancelPoll(pollTimer);
    pollTimer = undefined;
  }
  function scheduleNextPoll() {
    stopPolling();
    if (!visibility.isVisible()) return;
    if (!supportsConnection()) return;
    pollTimer = schedulePoll(() => {
      pollTimer = undefined;
      void load(true);
    }, 3000);
  }
  function visibilityChanged() {
    const visible = visibility.isVisible();
    const becameVisible = visible && !wasVisible;
    if (!visible && wasVisible) surfaceRevision += 1;
    wasVisible = visible;
    if (!visible) {
      stopPolling();
      return;
    }
    if (becameVisible) void load();
  }
  function isCurrentResponse(operation) {
    return operation === revision;
  }
  function beginRequest(background = false) {
    stopPolling();
    state.busy = !background;
    backgroundPending = background;
    if (!background) state.error = "";
    if (!background) state.actionError = "";
    notify();
    return ++revision;
  }
  function finishRequest(operation) {
    if (!isCurrentResponse(operation)) return;
    state.busy = false;
    backgroundPending = false;
    notify();
    scheduleNextPoll();
  }
  async function load(background = false) {
    if (state.busy) return false;
    const backgroundAlreadyLoading = background && backgroundPending;
    if (backgroundAlreadyLoading) return false;
    if (!supportsConnection()) {
      state.snapshot = null;
      notify();
      return false;
    }
    const operation = beginRequest(background);
    try {
      const snapshot = await loadConnection();
      if (!isCurrentResponse(operation)) return false;
      state.snapshot = snapshot;
      state.statusUnavailable = false;
      state.error = "";
      if (hostSetupIsReady(snapshot)) {
        state.downloaded = null;
        state.message = "";
        state.actionError = "";
      }
      return true;
    } catch {
      if (!isCurrentResponse(operation)) return false;
      state.statusUnavailable = true;
      state.error = state.downloaded?.restartRequired
        ? "Waiting for WSL and ABot to return after setup."
        : "Could not check this computer. Refresh to try again.";
      return false;
    } finally {
      finishRequest(operation);
    }
  }
  function canInstallOnPlatform(platform) {
    if (state.busy) return false;
    if (!visibility.isVisible()) return false;
    if (!supportsConnection()) return false;
    if (hostSetupIsReady(state.snapshot)) return false;
    return state.snapshot?.readiness?.platforms?.includes(platform) === true;
  }
  function setupDownloadErrorMessage(error) {
    if (typeof error?.message !== "string")
      return "Setup could not be downloaded. Try again.";
    const message = error.message.trim().slice(0, 500);
    return message || "Setup could not be downloaded. Try again.";
  }
  async function install(platform) {
    if (!canInstallOnPlatform(platform)) return false;
    const operation = beginRequest();
    const surface = surfaceRevision;
    try {
      const receipt = await downloadSetup(platform);
      if (!isCurrentResponse(operation)) return false;
      if (surface !== surfaceRevision) return false;
      if (!visibility.isVisible()) return false;
      await saveDownload(receipt);
      state.downloaded = {
        filename: receipt.filename,
        expiresAt: receipt.expiresAt,
        restartRequired: receipt.restartRequired === true,
      };
      state.message =
        "Setup downloaded. Open the downloaded file and follow its instructions. Waiting for verification…";
      return true;
    } catch (error) {
      if (isCurrentResponse(operation))
        state.actionError = setupDownloadErrorMessage(error);
      return false;
    } finally {
      finishRequest(operation);
    }
  }
  async function revoke() {
    if (state.busy) return false;
    if (!supportsConnection()) return false;
    const operation = beginRequest();
    try {
      const snapshot = await revokeConnection();
      if (!isCurrentResponse(operation)) return false;
      state.snapshot = snapshot;
      state.downloaded = null;
      state.statusUnavailable = false;
      state.message = "Computer access revoked.";
      return true;
    } catch {
      if (isCurrentResponse(operation))
        state.error = "Computer access could not be revoked. Try again.";
      return false;
    } finally {
      finishRequest(operation);
    }
  }
  function setActive(active) {
    state.active = active;
    visibilityChanged();
  }
  function reset() {
    revision += 1;
    state.busy = false;
    backgroundPending = false;
    lastNotification = "";
    state.active = false;
    state.snapshot = null;
    state.statusUnavailable = false;
    state.downloaded = null;
    state.error = "";
    state.actionError = "";
    state.message = "";
    stopPolling();
    wasVisible = false;
  }
  return {
    state,
    load,
    install,
    revoke,
    markup,
    afterPaint,
    setActive,
    reset,
    mount(root) {
      state.root = root;
      visibility.watch();
      render();
      visibilityChanged();
    },
    dispose() {
      reset();
      visibility.dispose();
      state.root = null;
    },
  };
}
