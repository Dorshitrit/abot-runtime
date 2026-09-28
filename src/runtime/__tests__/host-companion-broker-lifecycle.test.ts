import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startHostBroker } from "../../computer-access/companion/broker-server.js";
import { readBrokerLocation } from "../../computer-access/companion/broker-location.js";
import { readHostStatus } from "../../computer-access/companion/broker-client.js";
import { HostConnection } from "../../computer-access/companion/connection.js";
import { HostPairingStore } from "../../computer-access/companion/pairing-store.js";
import { ensureHostStateDirectory, hostStateDirectory } from "../../computer-access/companion/private-store.js";
import { isProcessOwnerAlive, requireCurrentProcessOwnerIdentity } from "../../computer-access/companion/process-owner-identity.js";
import { acquireFileLock } from "../adapters/long-term-memory/file-lock/acquisition.js";
import { installLockDirectory } from "../adapters/long-term-memory/file-lock/install.js";

type Broker = Awaited<ReturnType<typeof startHostBroker>>;
const roots: string[] = [];
const brokers = new Set<Broker>();
const connections = new Map<Broker, HostConnection>();
const socketDirectories = new Set<string>();
async function freshRoot() {
  const rootDir = await mkdtemp(join(tmpdir(), "abot-broker-lifecycle-"));
  roots.push(rootDir);
  return rootDir;
}
async function start(rootDir: string) {
  ensureHostStateDirectory(hostStateDirectory(rootDir));
  const connection = new HostConnection(new HostPairingStore(rootDir));
  const broker = await startHostBroker(rootDir, connection, async () => acquireFileLock(
    join(hostStateDirectory(rootDir), "owner.lock"),
    { waitMs: 0, ownerIdentity: await requireCurrentProcessOwnerIdentity(), processIsAlive: isProcessOwnerAlive },
  ));
  brokers.add(broker);
  connections.set(broker, connection);
  socketDirectories.add(dirname(readBrokerLocation(rootDir)!.socketPath));
  return broker;
}
async function stop(broker: Broker) {
  await broker.close();
  brokers.delete(broker);
  connections.delete(broker);
}
async function writeOldReceipt(rootDir: string, value: string) {
  const directory = hostStateDirectory(rootDir);
  ensureHostStateDirectory(directory);
  await writeFile(join(directory, "broker.json"), value, { mode: 0o600 });
}
afterEach(async () => {
  for (const broker of brokers) await stop(broker);
  for (const rootDir of roots.splice(0)) await rm(rootDir, { recursive: true, force: true });
  for (const directory of socketDirectories) await rm(directory, { recursive: true, force: true });
  socketDirectories.clear();
});

describe.skipIf(!["linux", "darwin"].includes(process.platform))("private companion broker lifecycle", () => {
  test("a competing broker cannot replace the live owner's receipt or listener", async () => {
    const rootDir = await freshRoot();
    const first = await start(rootDir);
    const status = vi.spyOn(connections.get(first)!, "status");
    const owner = readBrokerLocation(rootDir);
    expect(owner).toBeDefined();
    await expect(start(rootDir)).rejects.toThrow("long_term_memory_store_lock_timeout");
    expect(readBrokerLocation(rootDir)).toEqual(owner);
    expect(await readHostStatus(rootDir)).toEqual({ paired: false, connected: false });
    expect(status).toHaveBeenCalledOnce();
  });

  test("simultaneous startup has exactly one owner and preserves a usable broker", async () => {
    const rootDir = await freshRoot();
    const results = await Promise.allSettled([start(rootDir), start(rootDir)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { message: "long_term_memory_store_lock_timeout" } });
    const winner = results.find((result) => result.status === "fulfilled")!;
    const status = vi.spyOn(connections.get(winner.value)!, "status");
    expect(readBrokerLocation(rootDir)).toBeDefined();
    expect(await readHostStatus(rootDir)).toEqual({ paired: false, connected: false });
    expect(status).toHaveBeenCalledOnce();
  });

  test("the listener and its credential are protected by an owner-only directory", async () => {
    const rootDir = await freshRoot();
    await start(rootDir);
    const location = readBrokerLocation(rootDir)!;
    expect(location.socketPath.startsWith("\0")).toBe(false);
    expect((await lstat(location.socketPath)).isSocket()).toBe(true);
    const directory = await lstat(dirname(location.socketPath));
    expect(directory.uid).toBe(process.getuid!());
    expect(directory.mode & 0o077).toBe(0);
    expect((await lstat(join(hostStateDirectory(rootDir), "broker.json"))).mode & 0o077).toBe(0);
  });

  test("a recycled PID from an older process incarnation does not block startup", async () => {
    const rootDir = await freshRoot();
    ensureHostStateDirectory(hostStateDirectory(rootDir));
    await installLockDirectory(join(hostStateDirectory(rootDir), "owner.lock"), randomUUID(), "previous-boot:previous-start");
    const broker = await start(rootDir);
    const status = vi.spyOn(connections.get(broker)!, "status");
    expect(await readHostStatus(rootDir)).toEqual({ paired: false, connected: false });
    expect(status).toHaveBeenCalledOnce();
  });

  test.each([
    ["invalid JSON", "leftover-partial-json"],
    ["obsolete schema", JSON.stringify({ pid: 2_147_483_647, socketPath: "/obsolete/broker.sock" })],
    ["reused live PID", JSON.stringify({ pid: process.pid, ownerId: randomUUID(), token: randomBytes(32).toString("base64url"), socketPath: "obsolete" })],
  ])("startup recovers a persisted %s receipt when no listener owns the address", async (_label, receipt) => {
    const rootDir = await freshRoot();
    await writeOldReceipt(rootDir, receipt);
    await start(rootDir);
    expect(readBrokerLocation(rootDir)).toMatchObject({
      ownerId: expect.any(String), token: expect.any(String), socketPath: expect.any(String),
    });
    expect(await readHostStatus(rootDir)).toEqual({ paired: false, connected: false });
  });

  test("restart replaces a stale private receipt without changing the paired host", async () => {
    const rootDir = await freshRoot();
    const store = new HostPairingStore(rootDir);
    const invitation = store.begin();
    const grant = store.consume(invitation.code, { name: "Owner host", os: "windows", user: "owner", homeDir: "C:\\Users\\owner" });
    const first = await start(rootDir);
    const oldReceipt = readBrokerLocation(rootDir)!;
    await stop(first);
    expect(readBrokerLocation(rootDir)).toBeUndefined();
    await writeOldReceipt(rootDir, JSON.stringify({ ...oldReceipt, pid: process.pid }));
    await start(rootDir);
    const newReceipt = readBrokerLocation(rootDir)!;
    expect(newReceipt.ownerId).not.toBe(oldReceipt.ownerId);
    expect(newReceipt.token).not.toBe(oldReceipt.token);
    expect(await readHostStatus(rootDir)).toMatchObject({ paired: true, connected: false, hostId: grant.hostId });
    expect(store.authenticate(grant.credential)).toBe("credential");
  });
});

describe("companion pairing lifetime", () => {
  test("an expired invitation cannot create host authority", async () => {
    const rootDir = await freshRoot();
    let clock = 1_000;
    const store = new HostPairingStore(rootDir, () => clock);
    const invitation = store.begin();
    clock += 5 * 60_000;
    expect(store.authenticate(invitation.code)).toBeUndefined();
    expect(() => store.consume(invitation.code, { name: "Expired", os: "linux", user: "owner", homeDir: "/home/owner" })).toThrow("host_pairing_expired");
    expect(store.host()).toBeUndefined();
  });

  test("revocation invalidates old credentials and a new pairing receives a distinct identity", async () => {
    const rootDir = await freshRoot();
    const store = new HostPairingStore(rootDir);
    const identity = { name: "Owner", os: "macos", user: "owner", homeDir: "/Users/owner" } as const;
    const old = store.consume(store.begin().code, identity);
    store.revoke();
    expect(store.authenticate(old.credential)).toBeUndefined();
    expect(store.host()).toBeUndefined();
    const next = store.consume(store.begin().code, identity);
    expect(next.hostId).not.toBe(old.hostId);
    expect(store.authenticate(old.credential)).toBeUndefined();
    expect(store.authenticate(next.credential)).toBe("credential");
  });
});
