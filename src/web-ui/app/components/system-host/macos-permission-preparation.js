import { hasCompletePermissionReceipt, macPermissionScopes } from "./macos-permission-scopes.js";

export function createMacPermissionPreparation({
  state, requestPermissions, beginRequest, finishRequest, isCurrentResponse,
  getSurfaceRevision, isVisible, getEnvironmentId,
}) {
  function clear() {
    for (const route of Object.values(macPermissionScopes)) {
      state[route.receiptKey] = null;
      state[route.errorKey] = "";
    }
  }
  function reconcile() {
    for (const route of Object.values(macPermissionScopes)) {
      if (route.matches(state[route.receiptKey], state.snapshot, getEnvironmentId())) continue;
      state[route.receiptKey] = null;
      state[route.errorKey] = "";
    }
  }
  function canPreparePermissions(route) {
    if (state.busy || state.statusUnavailable) return false;
    if (!isVisible()) return false;
    if (typeof requestPermissions !== "function") return false;
    return route.canCheck(state.snapshot, getEnvironmentId());
  }
  function canApplyPermissionResponse(operation, surface, route, binding) {
    if (!isCurrentResponse(operation)) return false;
    if (surface !== getSurfaceRevision()) return false;
    if (!isVisible()) return false;
    return route.matches(binding, state.snapshot, getEnvironmentId());
  }
  function permissionStillRequired(permission, route) {
    const receipt = state[route.receiptKey];
    if (!route.matches(receipt, state.snapshot, getEnvironmentId())) return false;
    if (permission === "screen_recording")
      return receipt.permissions.screenRecording === "required";
    if (permission === "accessibility")
      return receipt.permissions.accessibility === "required";
    return false;
  }
  async function prepare(permission, scope = "companion") {
    const route = macPermissionScopes[scope];
    if (!route || !canPreparePermissions(route)) return false;
    if (permission && !permissionStillRequired(permission, route)) return false;
    const binding = route.binding(state.snapshot);
    const surface = getSurfaceRevision();
    state[route.errorKey] = "";
    const operation = beginRequest();
    try {
      const receipt = await requestPermissions({
        ...binding,
        action: permission ? "request" : "check",
        ...(permission ? { permission } : {}),
      });
      if (!canApplyPermissionResponse(operation, surface, route, binding)) return false;
      if (!route.matches(receipt, state.snapshot, getEnvironmentId()))
        throw new Error("permission_receipt_binding_invalid");
      if (receipt.scope !== scope || !hasCompletePermissionReceipt(receipt))
        throw new Error("permission_receipt_unavailable");
      state[route.receiptKey] = receipt;
      return true;
    } catch {
      if (!canApplyPermissionResponse(operation, surface, route, binding)) return false;
      state[route.receiptKey] = null;
      state[route.errorKey] = "Permission preparation could not complete. Check the executing Mac, its macOS 14 or later version and Swift developer tools. Refresh the connection, then check again.";
      return false;
    } finally {
      finishRequest(operation);
    }
  }
  function afterPaint(root) {
    for (const [scope, route] of Object.entries(macPermissionScopes)) {
      root?.querySelector(`[data-${route.selector}-permissions-check]`)
        ?.addEventListener("click", () => void prepare(undefined, scope));
      for (const permission of ["screen_recording", "accessibility"])
        root?.querySelector(`[data-${route.selector}-permission-request="${permission}"]`)
          ?.addEventListener("click", () => void prepare(permission, scope));
    }
  }
  return { clear, reconcile, afterPaint, checkPermissions: () => prepare(), requestPermission: prepare,
    checkNativePermissions: () => prepare(undefined, "native_runtime"),
    requestNativePermission: permission => prepare(permission, "native_runtime") };
}
