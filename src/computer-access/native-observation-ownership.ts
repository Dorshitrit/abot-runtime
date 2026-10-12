import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { acquireFileLock } from "../runtime/adapters/long-term-memory/file-lock/acquisition.js";
import { ensurePrivateRuntimeDirectory } from "../runtime/local-host/private-directory.js";
import { isProcessOwnerAlive, requireCurrentProcessOwnerIdentity } from "./companion/process-owner-identity.js";
import { hostStateDirectory, readHostPrivateJson, writeHostPrivateJson } from "./companion/private-store.js";
import { isHostIdentifier, isHostRecord } from "./companion/protocol.js";

export type NativeObservationOwnership = Readonly<{ deviceId: string; release(): Promise<void> }>;

function isNativeDeviceIdentity(value: unknown): value is { version: 1; deviceId: string } {
  if (!isHostRecord(value)) return false;
  if (value.version !== 1) return false;
  return isHostIdentifier(value.deviceId);
}

function isNativeObservationOwnershipConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === "long_term_memory_store_lock_timeout";
}

function readNativeDeviceId(directory: string): string {
  const path = join(directory, "native-device.json");
  const value = readHostPrivateJson(path);
  if (value === undefined) {
    const deviceId = randomUUID();
    writeHostPrivateJson(path, { version: 1, deviceId });
    return deviceId;
  }
  if (!isNativeDeviceIdentity(value)) throw new Error("native_observation_identity_invalid");
  return value.deviceId;
}

/** One installation shares a device identity and exclusive collector across environment processes. */
export async function acquireNativeObservationOwnership(rootDir: string): Promise<NativeObservationOwnership> {
  const directory = hostStateDirectory(rootDir);
  await ensurePrivateRuntimeDirectory(directory);
  const ownerIdentity = await requireCurrentProcessOwnerIdentity();
  let release: () => Promise<void>;
  try {
    release = await acquireFileLock(join(directory, "native-observation-owner.lock"), {
      waitMs: 0, ownerIdentity, processIsAlive: isProcessOwnerAlive, releaseMode: "synchronous",
    });
  } catch (error) {
    if (isNativeObservationOwnershipConflict(error))
      throw new Error("host_observations_already_owned");
    throw error;
  }
  try { return { deviceId: readNativeDeviceId(directory), release }; }
  catch (error) { await release(); throw error; }
}
