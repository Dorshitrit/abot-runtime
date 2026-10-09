import { downloadHostSetup } from "./download.js";
import { hostSetupIsReady, renderSystemHostConnection } from "./rendering.js";
import { createSystemHostVisibility } from "./visibility.js";
import { createMacConnectionActions } from "./macos-connection-actions.js";
import { createMacPermissionPreparation } from "./macos-permission-preparation.js";
import { createWindowsStoreConnectionActions, windowsStoreSetupIsAvailable } from "./windows-store-setup.js";

export function createSystemHostConnectionManager({
  loadConnection,
  downloadSetup,
  requestStoreConnection,
  connectLocal,
  createPairing,
  requestPermissions,
  getEnvironmentId = () => "",
  getRuntimeOrigin = () => globalThis.location?.origin,
  revokeConnection,
  supportsConnection = () => true,
  saveDownload = downloadHostSetup,
  documentRoot = globalThis.document,
  compact = false,
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
    manualMac: null,
    windowsStoreInvitation: null,
    windowsStoreAttempt: null,
    managementOpen: false,
    macPermissions: null,
    macPermissionError: "",
    nativeMacPermissions: null,
    nativeMacPermissionError: "",
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
  const mac = createMacConnectionActions({
    state,
    connectLocal,
    createPairing,
    getRuntimeOrigin,
    canInstallOnPlatform,
    beginRequest,
    finishRequest,
    isCurrentResponse,
    load,
    getSurfaceRevision: () => surfaceRevision,
    isVisible: () => visibility.isVisible(),
  });
  const permissions = createMacPermissionPreparation({
    state, requestPermissions, beginRequest, finishRequest, isCurrentResponse, getEnvironmentId,
    getSurfaceRevision: () => surfaceRevision,
    isVisible: () => visibility.isVisible(),
  });
  const windowsStore = createWindowsStoreConnectionActions({
    state, requestStoreConnection, canInstallOnPlatform, beginRequest, finishRequest,
    revokeConnection, receiveUnpairedConnection, getEnvironmentId,
    isCurrentResponse, getSurfaceRevision: () => surfaceRevision,
    isVisible: () => visibility.isVisible(), notify,
  });
  function markup() {
    return renderSystemHostConnection({
      ...state,
      error: state.error || state.actionError,
      supported: supportsConnection(),
      compact,
    });
  }
  function afterPaint(root = state.root) {
    permissions.afterPaint(root);
    root?.querySelector("[data-system-host-store-connect]")
      ?.addEventListener("click", () => void windowsStore.connectWindowsStore());
    root?.querySelector("[data-system-host-store-launch]")
      ?.addEventListener("click", windowsStore.markLaunchRequested);
    root?.querySelector("[data-system-host-store-repair]")
      ?.addEventListener("click", windowsStore.beginWindowsStoreRepair);
    root?.querySelector("[data-system-host-store-repair-confirm]")
      ?.addEventListener("click", () => void windowsStore.confirmWindowsStoreRepair());
    root?.querySelector("[data-system-host-store-repair-cancel]")
      ?.addEventListener("click", windowsStore.cancelWindowsStoreRepair);
    const management = root?.querySelector("[data-system-host-management]");
    management?.addEventListener("toggle", () => {
      if (management !== state.root?.querySelector("[data-system-host-management]")) return;
      state.managementOpen = management.open;
      lastNotification = markup();
    });
    root
      ?.querySelector('[data-system-host-mac="local"]')
      ?.addEventListener("click", () => void mac.connectMac());
    root
      ?.querySelector('[data-system-host-mac="manual"]')
      ?.addEventListener("click", () => void mac.pairMac());
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
      state.manualMac = null;
      windowsStore.clear({ preserveWaiting: true });
      permissions.clear();
      notify();
      stopPolling();
      return;
    }
    if (becameVisible) void load();
  }
  function isCurrentResponse(operation) {
    return operation === revision;
  }
  function beginRequest(background = false, preserveStoreWaiting = false) {
    stopPolling();
    if (!background) windowsStore.clear({ preserveWaiting: preserveStoreWaiting });
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
    const operation = beginRequest(background, true);
    const environment = getEnvironmentId();
    try {
      const snapshot = await loadConnection();
      if (!isCurrentResponse(operation)) return false;
      if (environment !== getEnvironmentId()) return false;
      state.snapshot = snapshot;
      if (!windowsStoreSetupIsAvailable(snapshot)) windowsStore.clear();
      permissions.reconcile();
      state.statusUnavailable = false;
      state.error = "";
      if (hostSetupIsReady(snapshot)) {
        windowsStore.clear();
        state.manualMac = null;
        state.downloaded = null;
        state.message = "";
        state.actionError = "";
      }
      return true;
    } catch {
      if (!isCurrentResponse(operation)) return false;
      windowsStore.clear();
      state.statusUnavailable = true;
      permissions.clear();
      state.error = "Could not check this computer. Refresh to try again.";
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
    if (platform === "macos") return false;
    if (platform === "windows") return windowsStore.connectWindowsStore();
    if (!canInstallOnPlatform(platform)) return false;
    state.manualMac = null;
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
  function receiveUnpairedConnection(snapshot) {
    state.snapshot = snapshot;
    permissions.clear();
    state.downloaded = null;
    state.manualMac = null;
    state.statusUnavailable = false;
    state.message = "Computer unpaired.";
  }
  async function revoke() {
    if (state.busy) return false;
    if (!supportsConnection()) return false;
    windowsStore.clear();
    const operation = beginRequest();
    try {
      const snapshot = await revokeConnection();
      if (!isCurrentResponse(operation)) return false;
      receiveUnpairedConnection(snapshot);
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
    state.manualMac = null;
    windowsStore.clear();
    state.error = "";
    state.actionError = "";
    state.message = "";
    state.managementOpen = false;
    permissions.clear();
    stopPolling();
    wasVisible = false;
    render();
  }
  return {
    state,
    load,
    install,
    connectWindowsStore: windowsStore.connectWindowsStore,
    beginWindowsStoreRepair: windowsStore.beginWindowsStoreRepair,
    cancelWindowsStoreRepair: windowsStore.cancelWindowsStoreRepair,
    confirmWindowsStoreRepair: windowsStore.confirmWindowsStoreRepair,
    ...mac,
    checkPermissions: permissions.checkPermissions,
    requestPermission: permissions.requestPermission,
    checkNativePermissions: permissions.checkNativePermissions,
    requestNativePermission: permissions.requestNativePermission,
    environmentChanged() {
      revision += 1;
      surfaceRevision += 1;
      state.busy = false;
      backgroundPending = false;
      state.snapshot = null;
      windowsStore.clear();
      permissions.clear();
      notify();
      if (visibility.isVisible()) void load();
    },
    revoke,
    markup,
    afterPaint,
    setActive,
    openManagement() {
      state.managementOpen = true;
      notify();
    },
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
