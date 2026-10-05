import { isHostRecord } from "../../computer-access/companion/protocol.js";
import { readMacPermissionResult } from "../../computer-access/companion/permission-protocol.js";
import { isNativePermissionStatus, type NativePermissionClient } from "../../computer-access/native-permission-contract.js";
import type { LocalRuntimeCallHandler } from "./contracts.js";

function boundPermissionWait<T>(pending: Promise<T>, milliseconds: number): Promise<T> {
  let deadline: NodeJS.Timeout;
  return Promise.race([
    pending,
    new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("macos_permissions_owner_unavailable")), milliseconds);
    }),
  ]).finally(() => clearTimeout(deadline));
}

/** No connection election or replay; old owners fail closed without blocking host status. */
export function createLocalNativePermissionClient(call: LocalRuntimeCallHandler): NativePermissionClient {
  let metadata: Promise<unknown> | undefined;
  return {
    async status() {
      metadata ??= call("nativePermissions.status", []).finally(() => { metadata = undefined; });
      try {
        const result = await boundPermissionWait(metadata, 2_000);
        if (isNativePermissionStatus(result)) return result;
      } catch { /* old or disconnected owners do not invalidate Companion readiness */ }
      return { available: false, reason: "runtime_owner_unavailable" };
    },
    async prepare(input) {
      const result = await boundPermissionWait(call("nativePermissions.prepare", [input]), 55_000);
      if (!isHostRecord(result) || result.ownerId !== input.ownerId)
        throw new Error("macos_permissions_owner_changed");
      const permissions = readMacPermissionResult(result);
      if (!permissions) throw new Error("macos_permissions_result_invalid");
      return { ...permissions, ownerId: input.ownerId };
    },
  };
}
