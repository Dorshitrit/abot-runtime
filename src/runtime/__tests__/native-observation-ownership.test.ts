import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { acquireNativeObservationOwnership } from "../../computer-access/native-observation-ownership.js";
import { hostStateDirectory } from "../../computer-access/companion/private-store.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const base = join(process.cwd(), ".codex/artifacts/windows-native-computer-access/ownership-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "root-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function acquire(root: string) {
  const ownership = await acquireNativeObservationOwnership(root);
  cleanup.push(ownership.release);
  return ownership;
}
async function childAcquire(root: string) {
  const module = pathToFileURL(join(process.cwd(), "src/computer-access/native-observation-ownership.ts")).href;
  const script = `import { acquireNativeObservationOwnership } from ${JSON.stringify(module)};
    try { const lease = await acquireNativeObservationOwnership(process.argv[1]);
      console.log(lease.deviceId); await lease.release(); }
    catch (error) { console.log(error.message); }`;
  return (await promisify(execFile)(process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, root], { windowsHide: true })).stdout.trim();
}

// Windows verifies ACLs and process identity through multiple bounded PowerShell probes.
test("a root has one owner across environments and processes, and identity survives reconnect and process restart", async () => {
  const root = await fixture();
  const first = await acquire(root);
  await expect(acquireNativeObservationOwnership(root)).rejects.toThrow("host_observations_already_owned");
  expect(await childAcquire(root)).toBe("host_observations_already_owned");
  await first.release();
  const second = await acquire(root);
  expect(second.deviceId).toBe(first.deviceId);
  await second.release();
  expect(await childAcquire(root)).toBe(first.deviceId);
}, 30_000);

test("moving an installation preserves its private native device identity", async () => {
  const root = await fixture();
  const first = await acquire(root); await first.release();
  const moved = root + "-moved";
  await rename(root, moved);
  cleanup.push(() => rm(moved, { recursive: true, force: true }));
  const next = await acquire(moved);
  expect(next.deviceId).toBe(first.deviceId);
}, 30_000);

test("invalid persisted identity fails closed and does not strand the owner lock", async () => {
  const root = await fixture();
  const first = await acquire(root); await first.release();
  const path = join(hostStateDirectory(root), "native-device.json");
  await writeFile(path, JSON.stringify({ version: 2, deviceId: "invalid" }), { mode: 0o600 });
  await expect(acquireNativeObservationOwnership(root)).rejects.toThrow("native_observation_identity_invalid");
  await writeFile(path, JSON.stringify({ version: 1, deviceId: first.deviceId }), { mode: 0o600 });
  await expect(acquire(root)).resolves.toMatchObject({ deviceId: first.deviceId });
}, 30_000);
