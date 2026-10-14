import { connectionDescription, connectionStatus, connectionTitle, hostSetupIsReady } from "./rendering.js";
import { isNativeWindowsLocalAccess, nativeWindowsAccessPresentation } from "./native-windows-access.js";
import { computerWidgetPreview } from "./home-widget-permission-preview.js";
import { macPermissionSummary, permissionSummary } from "./macos-permission-rendering.js";
import { permissionsMatchConnection, permissionsMatchNativeOwner } from "./macos-permission-scopes.js";
import { storeConnectionStage, storeConnectionDisplayContent, windowsStorePanelIsAvailable } from "./windows-store-setup.js";

function currentMacPermissionStates(state) {
  const snapshot = state.snapshot;
  const states = [];
  if (permissionsMatchConnection(state.macPermissions, snapshot))
    states.push(permissionSummary(state.macPermissions));
  if (permissionsMatchNativeOwner(state.nativeMacPermissions, snapshot, snapshot?.nativePermissions?.environmentId))
    states.push(permissionSummary(state.nativeMacPermissions));
  return states;
}

function hasComputerActionFailure(state) {
  return Boolean(state.error || state.actionError || state.macPermissionError || state.nativeMacPermissionError);
}

function computerPermissionTone(state, permissionText) {
  if (hasComputerActionFailure(state)) return "attention";
  const status = connectionStatus(state.snapshot, state.statusUnavailable, state.busy);
  if (["Paired · offline", "Update needed", "Computer access unavailable"].includes(status)) return "attention";
  const states = currentMacPermissionStates(state);
  if (states.includes("action needed")) return "attention";
  // A connected Mac with unmeasured or unavailable permissions is not all-clear.
  if (permissionText) return "neutral";
  if (hostSetupIsReady(state.snapshot)) return "success";
  return "neutral";
}

function windowsStoreTone(state, stage) {
  if (hasComputerActionFailure(state)) return "attention";
  if (state.busy) return "neutral";
  const tones = { ready: "success", reconnect: "attention", expired: "attention", "confirm-repair": "attention", preparing: "active", repairing: "active", waiting: "active", open: "active" };
  return tones[stage] || "neutral";
}

function nativeWindowsTone(state, status) {
  if (hasComputerActionFailure(state)) return "attention";
  if (status === "Check needed") return "attention";
  return "neutral";
}

function windowsStoreSummary(state) {
  const snapshot = state.snapshot;
  const invitation = state.windowsStoreInvitation;
  const stage = storeConnectionStage(snapshot, invitation, state.windowsStoreAttempt);
  const content = storeConnectionDisplayContent(stage, snapshot, invitation, state.busy, state.statusUnavailable);
  return {
    title: snapshot.identity?.name || content.step,
    detail: state.error || state.actionError || state.message || content.copy,
    status: content.status,
    tone: windowsStoreTone(state, stage),
  };
}

/** Connection and process-bound permission receipts stay separate facts. */
export function computerAccessWidgetSummary(state = {}, supported = true) {
  const input = { ...state, supported };
  if (!supported)
    return { title: "Computer connection unavailable", detail: "Computer access setup requires the local Runtime backend.", status: "Unavailable", tone: "neutral" };
  if (state.statusUnavailable)
    return { title: "Check your computer connection", detail: "The current connection status could not be checked.", status: "Status unavailable", tone: "attention" };
  if (!state.snapshot)
    return { title: "Checking this computer…", detail: "", status: "Checking", tone: "neutral" };
  if (isNativeWindowsLocalAccess(state.snapshot)) {
    const presentation = nativeWindowsAccessPresentation(input);
    return {
      title: presentation.title,
      detail: state.error || state.actionError || state.message || presentation.description,
      status: presentation.status,
      tone: nativeWindowsTone(state, presentation.status),
    };
  }
  if (windowsStorePanelIsAvailable(state.snapshot)) return windowsStoreSummary(state);
  const permissionText = macPermissionSummary(state.snapshot, state.macPermissions, state.nativeMacPermissions);
  const title = state.snapshot.identity?.name || connectionTitle(input);
  if (state.busy)
    return { title, detail: "Waiting for the current connection status…", status: "Checking", tone: "neutral" };
  const feedback = state.error || state.actionError || state.macPermissionError || state.nativeMacPermissionError || state.message;
  const status = connectionStatus(state.snapshot, state.statusUnavailable, state.busy);
  const preview = feedback ? null : computerWidgetPreview(state, title, status);
  return {
    title,
    detail: feedback || permissionText || connectionDescription(input),
    status,
    tone: computerPermissionTone(state, permissionText),
    ...(preview ? { preview } : {}),
  };
}
