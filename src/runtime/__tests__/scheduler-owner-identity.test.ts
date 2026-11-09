import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as identity from "../../computer-access/companion/process-owner-identity.js";
import { acquireFileLock } from "../adapters/long-term-memory/file-lock/acquisition.js";
import { readLockSnapshot } from "../adapters/long-term-memory/file-lock/snapshot.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";

let directory: string;
const releases: (() => Promise<void>)[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "abot-scheduler-owner-identity-"));
});
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function holdLease(ownerIdentity?: string) {
  const release = await acquireFileLock(join(directory, "scheduler.owner"), { ownerIdentity });
  releases.push(release);
  return release;
}
async function expectRetainedOwner() {
  const path = join(directory, "scheduler.owner");
  const before = await readLockSnapshot(path);
  await expect(createFileSchedulerStore(directory).acquire())
    .rejects.toThrow("scheduler_store_in_use");
  expect(await readLockSnapshot(path)).toEqual(before);
}

test("new scheduler leases bind the incarnation and exclude another live owner", async () => {
  releases.push(await createFileSchedulerStore(directory).acquire());
  expect(await readLockSnapshot(join(directory, "scheduler.owner"))).toMatchObject({
    record: {
      pid: process.pid,
      ownerIdentity: await identity.requireCurrentProcessOwnerIdentity(),
    },
  });
  await expectRetainedOwner();
});

test("reused live PID with a stale incarnation permits a new scheduler owner", async () => {
  const releaseOld = await holdLease("previous-process-incarnation");
  const store = createFileSchedulerStore(directory);
  releases.push(await store.acquire());
  const path = join(directory, "scheduler.owner");
  const replacement = await readLockSnapshot(path);
  await releaseOld();
  expect(await readLockSnapshot(path)).toEqual(replacement);
  expect(replacement).toMatchObject({
    record: { ownerIdentity: await identity.requireCurrentProcessOwnerIdentity() },
  });
  expect(await store.read()).toEqual({ schemaVersion: 1, jobs: [], runs: [] });
});

test("a live legacy PID-only scheduler lease remains excluded", async () => {
  await holdLease();
  await expectRetainedOwner();
});

test("unreadable observed incarnation cannot reclaim a live scheduler lease", async () => {
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

test("unavailable current process identity never installs a scheduler lease", async () => {
  vi.spyOn(identity, "requireCurrentProcessOwnerIdentity")
    .mockRejectedValue(new Error("identity_unavailable"));
  await expect(createFileSchedulerStore(directory).acquire())
    .rejects.toThrow("identity_unavailable");
  expect(await readLockSnapshot(join(directory, "scheduler.owner"))).toBeUndefined();
});
