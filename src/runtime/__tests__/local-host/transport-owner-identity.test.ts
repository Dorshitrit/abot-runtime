import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as identity from "../../../computer-access/companion/process-owner-identity.js";
import { acquireFileLock } from "../../adapters/long-term-memory/file-lock/acquisition.js";
import { readLockSnapshot } from "../../adapters/long-term-memory/file-lock/snapshot.js";
import { writeLocalRuntimeEndpoint } from "../../local-host/endpoint.js";
import {
  createLocalRuntimeConnection,
  type LocalRuntimeConnection,
} from "../../local-host/transport.js";

let directory: string;
const connections: LocalRuntimeConnection[] = [];
const releases: (() => Promise<void>)[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "abot-transport-owner-identity-"));
});
afterEach(async () => {
  for (const connection of connections.splice(0).reverse()) await connection.close();
  for (const release of releases.splice(0)) await release();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const createOwner = async () => ({
  call: async () => process.pid,
  subscribe: () => () => {},
  stop: async () => {},
});
async function connect() {
  const connection = await createLocalRuntimeConnection({
    directory, identity: "environment", createOwner,
  });
  connections.push(connection);
  return connection;
}
async function holdLease(ownerIdentity?: string) {
  const release = await acquireFileLock(join(directory, "owner"), { ownerIdentity });
  releases.push(release);
  return release;
}
async function expectRetainedOwner() {
  const before = await readLockSnapshot(join(directory, "owner"));
  const factory = vi.fn(createOwner);
  await expect(createLocalRuntimeConnection({
    directory, identity: "environment", startupTimeoutMs: 50, createOwner: factory,
  })).rejects.toThrow("local_runtime_owner_start_timeout");
  expect(factory).not.toHaveBeenCalled();
  expect(await readLockSnapshot(join(directory, "owner"))).toEqual(before);
}

test("new local leases bind the process incarnation and live callers share one owner", async () => {
  const owner = await connect();
  const follower = await connect();
  expect(owner.ownership).toBe("owner");
  expect(follower.ownership).toBe("client");
  expect(await follower.call("ownerPid")).toBe(process.pid);
  expect(await readLockSnapshot(join(directory, "owner"))).toMatchObject({
    record: {
      pid: process.pid,
      ownerIdentity: await identity.requireCurrentProcessOwnerIdentity(),
    },
  });
});

test("reused live PID with a stale incarnation replaces the lease and stale endpoint", async () => {
  const releaseOld = await holdLease("previous-process-incarnation");
  await writeLocalRuntimeEndpoint(directory, {
    version: 1, identity: "previous-configuration", pid: process.pid,
    port: 1, token: randomBytes(32).toString("hex"),
  });
  expect((await connect()).ownership).toBe("owner");
  const replacement = await readLockSnapshot(join(directory, "owner"));
  await releaseOld();
  expect(await readLockSnapshot(join(directory, "owner"))).toEqual(replacement);
  expect(replacement).toMatchObject({
    record: { ownerIdentity: await identity.requireCurrentProcessOwnerIdentity() },
  });
});

test("a live legacy PID-only lease is retained without guessing its incarnation", async () => {
  await holdLease();
  await expectRetainedOwner();
});

test("unreadable observed incarnation cannot authorize replacing a live owner", async () => {
  await holdLease("unreadable-process-incarnation");
  const conservativeProbe = identity.createProcessOwnerIdentityProbe({
    platform: "linux", currentPid: process.pid,
    processIsAlive: () => true,
    readText: async () => { throw new Error("unreadable"); },
    execute: async () => { throw new Error("unavailable"); },
  });
  vi.spyOn(identity, "isProcessOwnerAlive")
    .mockImplementation(conservativeProbe.isProcessOwnerAlive);
  await expectRetainedOwner();
});

test("unavailable current process identity never installs a local owner lease", async () => {
  vi.spyOn(identity, "requireCurrentProcessOwnerIdentity")
    .mockRejectedValue(new Error("identity_unavailable"));
  await expect(connect()).rejects.toThrow("identity_unavailable");
  expect(await readLockSnapshot(join(directory, "owner"))).toBeUndefined();
});
