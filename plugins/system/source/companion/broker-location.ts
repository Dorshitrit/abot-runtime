import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureHostStateDirectory,
  hostStateDirectory,
  readHostPrivateJson,
  writeHostPrivateJson,
} from "./private-store.js";
import { isHostIdentifier, isHostRecord } from "./protocol.js";

export type HostBrokerLocation = {
  ownerId: string;
  token: string;
  socketPath: string;
};
function brokerRecordPath(rootDir: string): string {
  return join(hostStateDirectory(rootDir), "broker.json");
}
function brokerSocketPath(rootDir: string): string {
  if (process.platform !== "linux")
    throw new Error("host_broker_requires_linux_runtime");
  const key = createHash("sha256")
    .update(realpathSync(rootDir))
    .digest("hex")
    .slice(0, 20);
  return join(
    tmpdir(),
    `abot-host-${process.getuid?.()}-${key}`,
    "broker.sock",
  );
}
function isBrokerLocation(value: unknown): value is HostBrokerLocation {
  if (!isHostRecord(value)) return false;
  if (!isHostIdentifier(value.ownerId)) return false;
  if (typeof value.token !== "string") return false;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value.token)) return false;
  return typeof value.socketPath === "string";
}
export function readBrokerLocation(
  rootDir: string,
): HostBrokerLocation | undefined {
  const record = readHostPrivateJson(brokerRecordPath(rootDir));
  if (record === undefined) return undefined;
  if (!isBrokerLocation(record)) throw new Error("host_broker_record_invalid");
  if (record.socketPath !== brokerSocketPath(rootDir))
    throw new Error("host_broker_path_invalid");
  return record;
}
export function createBrokerLocation(rootDir: string): HostBrokerLocation {
  ensureHostStateDirectory(hostStateDirectory(rootDir));
  const socketPath = brokerSocketPath(rootDir);
  ensureHostStateDirectory(dirname(socketPath));
  removeAbandonedBrokerSocket(socketPath);
  return {
    ownerId: randomUUID(),
    token: randomBytes(32).toString("base64url"),
    socketPath,
  };
}
/** Called only while holding the installation's process-incarnation lease. */
function removeAbandonedBrokerSocket(socketPath: string): void {
  try {
    const stat = lstatSync(socketPath);
    if (!stat.isSocket()) throw new Error("host_broker_socket_invalid");
    if (stat.uid !== process.getuid?.())
      throw new Error("host_broker_socket_owner_invalid");
    unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
/** Call only after acquiring the installation lease and listener. */
export function publishBrokerLocation(
  rootDir: string,
  owner: HostBrokerLocation,
): void {
  writeHostPrivateJson(brokerRecordPath(rootDir), owner);
}
/** Release the receipt before the listener, while successors cannot acquire it. */
export function releaseBrokerLocation(
  rootDir: string,
  owner: HostBrokerLocation,
): void {
  const current = readBrokerLocation(rootDir);
  if (current?.ownerId !== owner.ownerId) return;
  unlinkSync(brokerRecordPath(rootDir));
}
