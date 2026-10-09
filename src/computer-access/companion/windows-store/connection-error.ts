import type { NativeHostConnection } from "../native-state.js";

export function hasMissingStoreUpgradeConnection(
  upgradeHostId: string | undefined,
  saved: NativeHostConnection | undefined,
): boolean {
  if (upgradeHostId === undefined) return false;
  return saved === undefined;
}

/** Fixed Store helper failure codes. Never serialize underlying errors or invitations. */
export class MissingStoreConnectionError extends Error {
  constructor() {
    super("companion_local_pairing_missing");
    this.name = "MissingStoreConnectionError";
  }
}

export function serializeStoreConnectionError(error: unknown): string {
  return JSON.stringify({
    error: error instanceof MissingStoreConnectionError
      ? "companion_local_pairing_missing"
      : "companion_request_failed",
  });
}
