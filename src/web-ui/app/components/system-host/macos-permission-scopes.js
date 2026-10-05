/** Each receipt belongs to its executing process, never the browser computer. */
export function canCheckMacPermissions(snapshot) {
  if (snapshot?.identity?.os !== "macos") return false;
  if (!snapshot.connected) return false;
  if (!snapshot.hostId || !snapshot.connectionId) return false;
  if (snapshot.readiness?.companionUpdateRequired) return false;
  return snapshot.capabilities?.includes("macos_permission_preflight_v1") === true;
}

export function permissionsMatchConnection(receipt, snapshot) {
  if (!receipt || !canCheckMacPermissions(snapshot)) return false;
  if (receipt.hostId !== snapshot.hostId) return false;
  return receipt.connectionId === snapshot.connectionId;
}

export function canCheckNativePermissions(snapshot, environmentId) {
  const native = snapshot?.nativePermissions;
  if (native?.available !== true) return false;
  if (native.scope !== "native_runtime") return false;
  if (typeof native.ownerId !== "string" || !native.ownerId) return false;
  return native.environmentId === environmentId;
}

export function permissionsMatchNativeOwner(receipt, snapshot, environmentId) {
  if (!receipt || !canCheckNativePermissions(snapshot, environmentId)) return false;
  if (receipt.scope !== "native_runtime") return false;
  if (receipt.environmentId !== environmentId) return false;
  return receipt.ownerId === snapshot.nativePermissions.ownerId;
}

export function hasCompletePermissionReceipt(receipt) {
  if (receipt?.ok !== true) return false;
  if (typeof receipt.executablePath !== "string") return false;
  if (!receipt.executablePath.startsWith("/")) return false;
  const statuses = ["granted", "required"];
  if (!statuses.includes(receipt.permissions?.screenRecording)) return false;
  return statuses.includes(receipt.permissions?.accessibility);
}

export const macPermissionScopes = {
  companion: {
    receiptKey: "macPermissions", errorKey: "macPermissionError", selector: "mac",
    canCheck: canCheckMacPermissions, matches: permissionsMatchConnection,
    binding: snapshot => ({ hostId: snapshot.hostId, connectionId: snapshot.connectionId }),
  },
  native_runtime: {
    receiptKey: "nativeMacPermissions", errorKey: "nativeMacPermissionError", selector: "native-mac",
    canCheck: canCheckNativePermissions, matches: permissionsMatchNativeOwner,
    binding: snapshot => ({ scope: "native_runtime", environmentId: snapshot.nativePermissions.environmentId, ownerId: snapshot.nativePermissions.ownerId }),
  },
};
