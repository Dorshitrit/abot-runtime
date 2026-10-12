import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { withFileLock } from "../adapters/long-term-memory/file-lock.js";
import { acquireFileLock } from "../adapters/long-term-memory/file-lock/acquisition.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), readdir: vi.fn(actual.readdir), lstat: vi.fn(actual.lstat) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.readdir).mockImplementation(actual.readdir);
  vi.mocked(fs.lstat).mockImplementation(actual.lstat);
  await Promise.all(roots.splice(0).map((root) => actual.rm(root, { recursive: true, force: true })));
});

async function heldLock(platform = "win32") {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  const root = await actual.mkdtemp(join(tmpdir(), "file-lock-observation-"));
  roots.push(root);
  const lockPath = join(root, "state.lock");
  const release = await acquireFileLock(lockPath, {});
  const leasePath = join(lockPath, "lease");
  const [entry] = await actual.readdir(leasePath);
  const ownerPath = join(leasePath, entry);
  const originalOwner = await actual.readFile(ownerPath, "utf8");
  const nativeProcess = Object.create(process);
  Object.defineProperty(nativeProcess, "platform", { value: platform });
  vi.stubGlobal("process", nativeProcess);
  return { actual, root, lockPath, leasePath, ownerPath, originalOwner, release };
}

test.each(["lock stat", "lock scan", "lease scan", "owner open"])(
  "waits for a contended Windows %s to become observable without entering or deleting a live lease",
  async (part) => {
    const fixture = await heldLock();
    const { actual, root, lockPath, leasePath, ownerPath, originalOwner, release } = fixture;
    const operation = vi.fn(async () => "saved once");
    const denied = Object.assign(new Error("Pending Windows deletion"), { code: "EPERM" });
    let observations = 0;
    const inspect = async () => {
      observations++;
      expect(operation).not.toHaveBeenCalled();
      expect(await actual.readFile(ownerPath, "utf8")).toBe(originalOwner);
      // The first denial is followed by a successful stat of the still-present path.
      if (observations === 1) throw denied;
      await release();
    };
    if (part === "owner open") {
      vi.mocked(fs.open).mockImplementation(async (path, ...args) => {
        if (String(path) === ownerPath) await inspect();
        return actual.open(path, ...args);
      });
    } else if (part === "lock stat") {
      vi.mocked(fs.lstat).mockImplementation((async (path, ...args) => {
        if (String(path) !== lockPath) return actual.lstat(path, ...args);
        // Keep the immediate follow-up stat readable; fail only the first observation.
        if (observations !== 1) await inspect();
        else observations++;
        return actual.lstat(path, ...args);
      }) as typeof fs.lstat);
    } else {
      const observedPath = part === "lock scan" ? lockPath : leasePath;
      vi.mocked(fs.readdir).mockImplementation((async (
        path: Parameters<typeof fs.readdir>[0], options: Parameters<typeof fs.readdir>[1],
      ) => {
        if (String(path) === observedPath) await inspect();
        return actual.readdir(path, options);
      }) as typeof fs.readdir);
    }
    expect(await withFileLock(lockPath, operation, { retryDelayMs: 1 })).toBe("saved once");
    expect(observations).toBeGreaterThanOrEqual(2);
    expect(operation).toHaveBeenCalledOnce();
    expect(await actual.readdir(root)).toEqual([]);
  },
);

test("a persistent Windows observation denial keeps its error and live owner at the acquisition deadline", async () => {
  const { actual, lockPath, ownerPath, originalOwner, release } = await heldLock();
  const denied = Object.assign(new Error("Permanent access denial"), { code: "EPERM" });
  const operation = vi.fn(async () => undefined);
  let clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  let attempts = 0;
  vi.mocked(fs.readdir).mockImplementation((async (
    path: Parameters<typeof fs.readdir>[0], options: Parameters<typeof fs.readdir>[1],
  ) => {
    if (String(path) !== lockPath) return actual.readdir(path, options);
    attempts++;
    clock += 10;
    throw denied;
  }) as typeof fs.readdir);
  await expect(withFileLock(lockPath, operation, { waitMs: 20, retryDelayMs: 1 })).rejects.toBe(denied);
  expect(attempts).toBe(2);
  expect(operation).not.toHaveBeenCalled();
  expect(await actual.readFile(ownerPath, "utf8")).toBe(originalOwner);
  await release();
});

test.each([["linux", "EPERM"], ["darwin", "EPERM"], ["win32", "EACCES"], ["win32", "EIO"]])(
  "%s propagates %s without waiting or entering the protected operation",
  async (platform, code) => {
    const { actual, lockPath, ownerPath, originalOwner, release } = await heldLock(platform);
    const failure = Object.assign(new Error("Observation failed"), { code });
    const operation = vi.fn(async () => undefined);
    let attempts = 0;
    vi.mocked(fs.readdir).mockImplementation((async (
      path: Parameters<typeof fs.readdir>[0], options: Parameters<typeof fs.readdir>[1],
    ) => {
      if (String(path) !== lockPath) return actual.readdir(path, options);
      attempts++;
      throw failure;
    }) as typeof fs.readdir);
    await expect(withFileLock(lockPath, operation)).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(operation).not.toHaveBeenCalled();
    expect(await actual.readFile(ownerPath, "utf8")).toBe(originalOwner);
    await release();
  },
);

test("does not repeat a protected operation that fails with EPERM", async () => {
  const { actual, root, lockPath, release } = await heldLock();
  await release();
  const failure = Object.assign(new Error("Write denied"), { code: "EPERM" });
  const operation = vi.fn(async () => { throw failure; });
  await expect(withFileLock(lockPath, operation)).rejects.toBe(failure);
  expect(operation).toHaveBeenCalledOnce();
  expect(await actual.readdir(root)).toEqual([]);
});
