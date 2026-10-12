import * as fs from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { acquireStoreLock } from "../../../plugins/memory/source/store-lock.js";
import { rethrowLockObservationError } from "../../../plugins/memory/source/lock-path-observation.js";
import { createPortablePluginFixture, removePortablePluginFixtures } from "./windows-portable-plugins-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir), lstat: vi.fn(actual.lstat) };
});

afterEach(async () => {
  vi.mocked(fs.readdir).mockReset();
  vi.mocked(fs.lstat).mockReset();
  vi.unstubAllGlobals();
  await removePortablePluginFixtures();
});

function emulateWindowsLockObservation(): void {
  const nativeProcess = Object.create(process) as NodeJS.Process;
  Object.defineProperty(nativeProcess, "platform", { value: "win32" });
  vi.stubGlobal("process", nativeProcess);
}

test.each(["lock", "lease"] as const)("handles a disappeared %s directory without reclaiming a live owner", async (part) => {
  const context = await createPortablePluginFixture("memory");
  const storePath = join(context.stateDir, "memory.json");
  const lockPath = `${storePath}.lock`;
  const observedPath = part === "lock" ? lockPath : join(lockPath, "lease");
  const release = await acquireStoreLock(storePath);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let injected = false;
  vi.mocked(fs.readdir).mockImplementation((async (path: Parameters<typeof fs.readdir>[0], options: Parameters<typeof fs.readdir>[1]) => {
    if (String(path) !== observedPath || injected) return actual.readdir(path, options);
    injected = true;
    await release();
    throw Object.assign(new Error("Windows pending directory deletion"), { code: "EPERM" });
  }) as typeof fs.readdir);
  emulateWindowsLockObservation();
  const acquired = await acquireStoreLock(storePath, { waitMs: 1000, retryMs: 1 });
  expect(injected).toBe(true);
  await acquired();
  expect(await actual.readdir(context.stateDir)).toEqual([]);
});

test.each(["unchanged", "unobservable"] as const)("preserves denial for an %s lock directory", async (kind) => {
  const context = await createPortablePluginFixture("memory");
  emulateWindowsLockObservation();
  const denied = Object.assign(new Error("Permission denied"), { code: "EPERM" });
  if (kind === "unobservable") {
    vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error("Read denied"), { code: "EACCES" }));
  }
  await expect(rethrowLockObservationError(context.stateDir, denied)).rejects.toBe(denied);
});
