import { randomUUID } from "node:crypto";
import { watch, type Stats } from "node:fs";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeNativeRuntimeUrl } from "./native-address.js";
import { isHostIdentifier, isHostRecord } from "./protocol.js";

export type NativeHostConnection = Readonly<{
  version: 1;
  url: string;
  hostId: string;
  credential: string;
}>;
export type NativePrivateAccess = Readonly<{
  ensureDirectory(path: string): Promise<void>;
  assertFile(path: string, stat: Stats): Promise<void>;
}>;
export const NATIVE_STATUS_INTERVAL_MS = 15_000;
export const NATIVE_STATUS_MAX_AGE_MS = NATIVE_STATUS_INTERVAL_MS * 3;
export type NativeHostState = Omit<
  ReturnType<typeof createNativeHostState>,
  "watch"
> & {
  watch?(changed: () => void): () => void;
};

export function isNativeCredential(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^[A-Za-z0-9_-]{32,256}$/u.test(value);
}

function readConnection(value: unknown): NativeHostConnection {
  if (!isHostRecord(value)) throw new Error("Invalid saved host connection.");
  if (value.version !== 1)
    throw new Error("Unsupported saved host connection version.");
  if (!isHostIdentifier(value.hostId))
    throw new Error("Invalid saved host identity.");
  if (!isNativeCredential(value.credential))
    throw new Error("Invalid saved host credential.");
  if (typeof value.url !== "string")
    throw new Error("Missing saved Runtime URL.");
  return {
    version: 1,
    url: normalizeNativeRuntimeUrl(value.url),
    hostId: value.hostId,
    credential: value.credential,
  };
}

export function hasSameNativeConnection(
  a: NativeHostConnection,
  b: NativeHostConnection,
): boolean {
  if (a.url !== b.url) return false;
  if (a.hostId !== b.hostId) return false;
  return a.credential === b.credential;
}

function isAbsentFile(error: unknown): boolean {
  return isHostRecord(error) && error.code === "ENOENT";
}

export function createNativeHostState(
  directory: string,
  access: NativePrivateAccess,
) {
  const connectionPath = join(directory, "connection.json");
  const statusPath = join(directory, "status.json");
  async function inspectPrivate(path: string): Promise<Stats | undefined> {
    await access.ensureDirectory(directory);
    const stat = await lstat(path).catch((error) => {
      if (isAbsentFile(error)) return undefined;
      throw error;
    });
    if (!stat) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Host companion state must be a private regular file.");
    await access.assertFile(path, stat);
    return stat;
  }
  async function readPrivate(path: string): Promise<unknown | undefined> {
    const stat = await inspectPrivate(path);
    if (!stat) return undefined;
    if (stat.size > 16_384)
      throw new Error("Host companion state exceeds its size limit.");
    return JSON.parse(await readFile(path, "utf8"));
  }
  async function writePrivate(path: string, value: unknown): Promise<void> {
    await access.ensureDirectory(directory);
    await readPrivate(path);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value) + "\n", {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await access.assertFile(temporary, await lstat(temporary));
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error) => {
        if (!isAbsentFile(error)) throw error;
      });
    }
  }
  async function read(): Promise<NativeHostConnection | undefined> {
    const value = await readPrivate(connectionPath);
    return value === undefined ? undefined : readConnection(value);
  }
  return {
    directory,
    read,
    watch(changed: () => void): () => void {
      try {
        const watcher = watch(directory, (_event, filename) => {
          if (filename === null || filename.toString() === "connection.json")
            changed();
        });
        watcher.on("error", changed);
        return () => watcher.close();
      } catch {
        // Filesystem notifications are optional; maintenance still checks state.
        return () => {};
      }
    },
    async write(connection: NativeHostConnection) {
      await writePrivate(connectionPath, readConnection(connection));
    },
    async remove(expected?: NativeHostConnection) {
      if (!expected) {
        if (await inspectPrivate(connectionPath)) await unlink(connectionPath);
        return;
      }
      const current = await read();
      if (!current) return;
      if (!hasSameNativeConnection(current, expected)) return;
      await unlink(connectionPath);
    },
    async setStatus(hostId: string, connected: boolean, buildId?: string) {
      await writePrivate(statusPath, {
        hostId,
        connected,
        pid: process.pid,
        observedAt: Date.now(),
        ...(buildId ? { buildId } : {}),
      });
    },
    async isConnected(
      hostId: string,
      buildId?: string,
      connectedAfter?: number,
    ): Promise<boolean> {
      const value = await readPrivate(statusPath);
      if (!isHostRecord(value)) return false;
      if (value.hostId !== hostId || value.connected !== true) return false;
      if (buildId !== undefined && value.buildId !== buildId) return false;
      if (typeof value.observedAt !== "number") return false;
      if (connectedAfter !== undefined && value.observedAt <= connectedAfter)
        return false;
      return Date.now() - value.observedAt < NATIVE_STATUS_MAX_AGE_MS;
    },
  };
}
