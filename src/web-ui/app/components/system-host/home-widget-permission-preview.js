import { hostSetupIsReady } from "./rendering.js";
import { hasNativePermissionSurface, permissionSummary } from "./macos-permission-rendering.js";
import { canCheckMacPermissions, canCheckNativePermissions, permissionsMatchConnection, permissionsMatchNativeOwner } from "./macos-permission-scopes.js";

function currentPermissionScopes(state) {
  const snapshot = state.snapshot;
  const scopes = [];
  if (snapshot.identity?.os === "macos") {
    scopes.push({
      available: canCheckMacPermissions(snapshot),
      current: permissionsMatchConnection(state.macPermissions, snapshot),
      receipt: state.macPermissions,
    });
  }
  if (hasNativePermissionSurface(snapshot)) {
    const environmentId = snapshot.nativePermissions?.environmentId;
    scopes.push({
      available: canCheckNativePermissions(snapshot, environmentId),
      current: permissionsMatchNativeOwner(state.nativeMacPermissions, snapshot, environmentId),
      receipt: state.nativeMacPermissions,
    });
  }
  return scopes;
}

function scopeRequiresPermission(scope) {
  if (!scope.current) return false;
  return permissionSummary(scope.receipt) === "action needed";
}

function scopeHasGrantedPermissions(scope) {
  if (!scope.current) return false;
  return permissionSummary(scope.receipt) === "granted";
}

function scopeCannotCheckPermissions(scope) {
  return !scope.available;
}

function computerPermissionIndicator(state) {
  const scopes = currentPermissionScopes(state);
  if (scopes.some(scopeRequiresPermission))
    return { icon: "failed", label: "Required", tone: "attention" };
  if (!scopes.length)
    return { icon: "neutral", label: "Unavailable", tone: "neutral" };
  if (scopes.some(scopeCannotCheckPermissions))
    return { icon: "paused", label: "Unavailable", tone: "neutral" };
  if (scopes.every(scopeHasGrantedPermissions))
    return { icon: "success", label: "Granted", tone: "success" };
  return { icon: "unknown", label: "Not checked", tone: "neutral" };
}

function canPreviewConnectedComputer(state) {
  if (state.snapshot?.connected !== true) return false;
  if (!hostSetupIsReady(state.snapshot)) return false;
  if (state.busy) return false;
  if (state.downloaded) return false;
  if (state.manualMac) return false;
  return true;
}

/** Project current receipts without requesting permissions or changing connection state. */
export function computerWidgetPreview(state, title, status) {
  if (!canPreviewConnectedComputer(state)) return null;
  const os = state.snapshot.identity?.os;
  return {
    kind: "computer",
    title,
    detail: { macos: "macOS", windows: "Windows", linux: "Linux" }[os] || os || "Unknown OS",
    items: [
      { label: "Connection", indicator: { icon: "success", label: status, tone: "success" } },
      { label: "Permissions", indicator: computerPermissionIndicator(state) },
    ],
  };
}
