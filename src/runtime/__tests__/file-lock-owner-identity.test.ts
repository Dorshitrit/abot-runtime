import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { acquireFileLock } from "../adapters/long-term-memory/file-lock/acquisition.js";
import { installLockDirectory } from "../adapters/long-term-memory/file-lock/install.js";
import { readLockSnapshot } from "../adapters/long-term-memory/file-lock/snapshot.js";
import { withFileLock } from "../adapters/long-term-memory/file-lock.js";

const roots: string[] = [];
const releases: (() => Promise<void>)[] = [];
async function lockPath() {
  const root = await mkdtemp(join(tmpdir(), "lock-owner-identity-"));
  roots.push(root);
  return join(root, "owner.lock");
}
afterEach(async () => {
  for (const release of releases.splice(0)) await release();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("optional opaque file-lock owner incarnation", () => {
  test("persists exact identity and passes it to an awaited liveness probe", async () => {
    const path = await lockPath();
    releases.push(await acquireFileLock(path, { ownerIdentity: "boot:process-start" }));
    expect(await readLockSnapshot(path)).toMatchObject({
      record: { pid: process.pid, ownerIdentity: "boot:process-start" },
    });
    let resolveLiveness!: (alive: boolean) => void;
    const probe = vi.fn(() => new Promise<boolean>((resolve) => { resolveLiveness = resolve; }));
    const contender = acquireFileLock(path, { waitMs: 0, processIsAlive: probe });
    const rejected = expect(contender).rejects.toThrow("long_term_memory_store_lock_timeout");
    await vi.waitFor(() => expect(probe).toHaveBeenCalledExactlyOnceWith(process.pid, "boot:process-start"));
    resolveLiveness(true);
    await rejected;
    expect(await readLockSnapshot(path)).toMatchObject({ record: { ownerIdentity: "boot:process-start" } });
  });

  test("a reused PID can be reclaimed only after its stored incarnation is rejected", async () => {
    const path = await lockPath();
    await installLockDirectory(path, randomUUID(), "old-incarnation");
    const probe = vi.fn(async (_pid: number, identity?: string) => identity === "current-incarnation");
    await withFileLock(path, async () => {
      expect(await readLockSnapshot(path)).toMatchObject({ record: { ownerIdentity: "current-incarnation" } });
    }, { ownerIdentity: "current-incarnation", processIsAlive: probe, waitMs: 0 });
    expect(probe).toHaveBeenCalledExactlyOnceWith(process.pid, "old-incarnation");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a rejected liveness probe cannot authorize stale cleanup", async () => {
    const path = await lockPath();
    releases.push(await acquireFileLock(path, { ownerIdentity: "owner-incarnation" }));
    await expect(acquireFileLock(path, {
      waitMs: 0,
      processIsAlive: async () => { throw new Error("identity_probe_failed"); },
    })).rejects.toThrow("identity_probe_failed");
    expect(await readLockSnapshot(path)).toMatchObject({ record: { ownerIdentity: "owner-incarnation" } });
  });

  test("legacy records retain PID liveness behavior without fabricating an identity", async () => {
    const path = await lockPath();
    releases.push(await acquireFileLock(path, {}));
    const probe = vi.fn(async () => true);
    await expect(acquireFileLock(path, { waitMs: 0, processIsAlive: probe })).rejects.toThrow("long_term_memory_store_lock_timeout");
    expect(probe).toHaveBeenCalledExactlyOnceWith(process.pid, undefined);
    const snapshot = await readLockSnapshot(path);
    expect(snapshot).toMatchObject({ record: { pid: process.pid } });
    if (snapshot?.kind !== "directory") throw new Error("missing directory lock");
    expect(snapshot.record).not.toHaveProperty("ownerIdentity");
  });

  test.each(["", "x".repeat(257), "\ninvalid", 42])("invalid optional metadata (%s) never becomes incarnation evidence", async (ownerIdentity) => {
    const path = await lockPath();
    const token = randomUUID();
    await installLockDirectory(path, token);
    const ownerPath = join(path, "lease", `owner-${token}.json`);
    const record = { ...JSON.parse(await readFile(ownerPath, "utf8")), ownerIdentity };
    await writeFile(ownerPath, JSON.stringify(record));
    const probe = vi.fn(async () => true);
    await expect(acquireFileLock(path, { waitMs: 0, processIsAlive: probe })).rejects.toThrow("long_term_memory_store_lock_timeout");
    expect(probe).toHaveBeenCalledExactlyOnceWith(process.pid, undefined);
    expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual(record);
  });

  test.each(["", "😀".repeat(100), "\ninvalid"])("invalid local identity is rejected before installing a lease", async (ownerIdentity) => {
    const path = await lockPath();
    await expect(acquireFileLock(path, { ownerIdentity })).rejects.toThrow("file_lock_owner_identity_invalid");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
