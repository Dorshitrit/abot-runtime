import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isProcessOwnerAlive, requireCurrentProcessOwnerIdentity } from "../../computer-access/companion/process-owner-identity.js";
import { parseSocketConnectionBundle, socketRegistrationId } from "./bundle.js";
import { validateRuntimeBridgeConnection, type RuntimeBridgeConnection } from "../../bridge/runtime-connection.js";
import { withFileLock } from "../adapters/long-term-memory/file-lock.js";
import type { RuntimeConfig } from "../ports.js";
import { assertPrivateRuntimeAccess } from "../local-host/private-access.js";
import { ensurePrivateRuntimeDirectory } from "../local-host/private-directory.js";

export type ManagedConnection = Readonly<{
  version: 1;
  revision: number;
  localEnvironmentId: string;
  enabled: boolean;
  format: "bundle" | "legacy";
  connection: RuntimeBridgeConnection | null;
}>;

const recordFile = /^[0-9a-f]{64}\.json$/;
const unavailable = () => new Error("socket_connection_store_unavailable");
function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

async function readPrivateJson(path: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const initial = await lstat(path);
    if (!initial.isFile() || initial.isSymbolicLink()) throw unavailable();
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== initial.dev || stat.ino !== initial.ino || stat.size > 32_768) throw unavailable();
    await assertPrivateRuntimeAccess(path, stat, "socket_connection_store_unavailable");
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) { if (missing(error)) return undefined; throw unavailable(); }
  finally { await handle?.close(); }
}

async function readRecord(path: string): Promise<ManagedConnection | undefined> {
  const value = await readPrivateJson(path) as ManagedConnection | undefined;
  if (value === undefined) return undefined;
  try {
    if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
        typeof value.localEnvironmentId !== "string" || typeof value.enabled !== "boolean") throw unavailable();
    if (value.format !== "bundle" && value.format !== "legacy") throw unavailable();
    let connection: RuntimeBridgeConnection | null = null;
    if (value.connection !== null) {
      if (!value.connection || typeof value.connection.runtimeId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.connection.runtimeId)) throw unavailable();
      connection = value.format === "legacy" ? validateRuntimeBridgeConnection(value.connection, value.connection.runtimeId) :
        parseSocketConnectionBundle({ runtimeId: value.connection.runtimeId, endpoint: value.connection.url, token: value.connection.token });
    } else if (value.enabled) throw unavailable();
    return { version: 1, localEnvironmentId: value.localEnvironmentId, revision: value.revision, enabled: value.enabled, format: value.format, connection };
  } catch { throw unavailable(); }
}

async function writeRecord(directory: string, path: string, record: object): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record), "utf8");
    await handle.sync();
    await handle.close();
    await assertPrivateRuntimeAccess(temporary, await lstat(temporary), "socket_connection_store_unavailable");
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const parent = await open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function sameBinding(a: RuntimeBridgeConnection, b: RuntimeBridgeConnection) {
  return new URL(a.url).origin === new URL(b.url).origin && a.runtimeId === b.runtimeId;
}

export function createSocketConnectionStore(config: RuntimeConfig) {
  const directory = join(config.paths.sharedDir, "socket-connections");
  const key = createHash("sha256").update(JSON.stringify([config.runtimeId, resolve(config.paths.runtimeDir)])).digest("hex") + ".json";
  const path = join(directory, key);
  const claimKey = key.replace(".json", ".claim.json");
  type Claim = { id: string; pid: number; ownerIdentity: string; remoteRuntimeId: string; origin: string };
  async function readClaim(name: string) {
    const claim = await readPrivateJson(join(directory, name)) as Claim | undefined;
    if (claim === undefined) return undefined;
    if (!claim || typeof claim.id !== "string" || !Number.isInteger(claim.pid) || claim.pid < 1 ||
        typeof claim.ownerIdentity !== "string" || !claim.ownerIdentity ||
        typeof claim.remoteRuntimeId !== "string" || typeof claim.origin !== "string") throw unavailable();
    return claim;
  }
  async function assertDirectory() {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
    await assertPrivateRuntimeAccess(directory, stat, "socket_connection_store_unavailable");
  }
  async function read(): Promise<ManagedConnection | undefined> {
    try { await assertDirectory(); } catch (error) { if (missing(error)) return undefined; throw unavailable(); }
    const record = await readRecord(path);
    if (record && record.localEnvironmentId !== config.runtimeId) throw unavailable();
    return record;
  }
  async function assertFree(connection: RuntimeBridgeConnection) {
    for (const other of await readdir(directory)) {
      if (other === key || other === claimKey) continue;
      if (/^[0-9a-f]{64}\.claim\.json$/.test(other)) {
        const claim = await readClaim(other);
        if (claim?.remoteRuntimeId === connection.runtimeId && claim.origin === new URL(connection.url).origin) {
          if (await isProcessOwnerAlive(claim.pid, claim.ownerIdentity)) throw new Error("socket_connection_binding_in_use");
          await rm(join(directory, other), { force: true });
        }
        continue;
      }
      if (!recordFile.test(other)) continue;
      const record = await readRecord(join(directory, other));
      if (record?.connection) {
        const runtimeId = socketRegistrationId(record.connection, record.format === "bundle");
        if (sameBinding({ ...record.connection, runtimeId }, connection)) throw new Error("socket_connection_binding_in_use");
      }
    }
  }
  return {
    read,
    async claim(connection: RuntimeBridgeConnection) {
      await ensurePrivateRuntimeDirectory(directory);
      const ownerIdentity = await requireCurrentProcessOwnerIdentity();
      const claim: Claim = { id: randomUUID(), pid: process.pid, ownerIdentity, remoteRuntimeId: connection.runtimeId,
        origin: new URL(connection.url).origin };
      await withFileLock(join(directory, "management.lock"), async () => {
        await assertFree(connection);
        const old = await readClaim(claimKey);
        if (old && await isProcessOwnerAlive(old.pid, old.ownerIdentity)) throw new Error("socket_connection_binding_in_use");
        await writeRecord(directory, join(directory, claimKey), claim);
      });
      return () => withFileLock(join(directory, "management.lock"), async () => {
        const current = await readClaim(claimKey);
        if (current?.id === claim.id && current.ownerIdentity === ownerIdentity) await rm(join(directory, claimKey));
      });
    },
    async change(expectedRevision: number, build: (previous: ManagedConnection | undefined) => Pick<ManagedConnection, "enabled" | "connection" | "format">) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("socket_connection_revision_conflict");
      try {
        await ensurePrivateRuntimeDirectory(directory);
        return await withFileLock(join(directory, "management.lock"), async () => {
          const previous = await read();
          if ((previous?.revision ?? 0) !== expectedRevision) throw new Error("socket_connection_revision_conflict");
          const next = build(previous);
          if (next.connection) {
            const runtimeId = socketRegistrationId(next.connection, next.format === "bundle");
            await assertFree({ ...next.connection, runtimeId });
          }
          const record: ManagedConnection = { version: 1, localEnvironmentId: config.runtimeId, revision: expectedRevision + 1, ...next };
          await writeRecord(directory, path, record);
          return record;
        });
      } catch (error) {
        if (error instanceof Error && /^socket_connection_[a-z_]+$/.test(error.message)) throw error;
        throw unavailable();
      }
    },
  };
}
