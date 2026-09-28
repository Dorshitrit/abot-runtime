import { isHostIdentifier } from "../computer-access/companion/protocol.js";
import type { NativeHostConnection } from "../computer-access/companion/native-state.js";

function hasConflictingSavedRuntime(
  saved: NativeHostConnection | undefined,
  requestedUrl: string,
): boolean {
  if (!saved) return false;
  return saved.url !== requestedUrl;
}

function resolveOrdinaryConnectUrl(
  saved: NativeHostConnection | undefined,
  requestedUrl: string,
): string {
  if (hasConflictingSavedRuntime(saved, requestedUrl))
    throw new Error(
      "A Runtime is already paired. Use 'abot host disconnect' before pairing another.",
    );
  return requestedUrl;
}

/** Upgrade identity selects existing private state, never a new credential destination. */
export function resolveHostCompanionSetupUrl(
  saved: NativeHostConnection | undefined,
  requestedUrl: string,
  upgradeHostId?: string,
): string {
  if (upgradeHostId === undefined)
    return resolveOrdinaryConnectUrl(saved, requestedUrl);
  if (!isHostIdentifier(upgradeHostId))
    throw new Error("Invalid paired computer identity.");
  if (!saved)
    throw new Error(
      "The paired computer connection is missing. Reconnect from ABot Settings.",
    );
  if (saved.hostId !== upgradeHostId)
    throw new Error(
      "This upgrade belongs to a different paired computer connection.",
    );
  return saved.url;
}
