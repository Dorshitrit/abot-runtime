import * as fs from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { claimStoreLockDirectory } from "../../../plugins/memory/source/lock-directory-claim.js";
import { createPortablePluginFixture, removePortablePluginFixtures } from "./windows-portable-plugins-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), lstat: vi.fn(actual.lstat) };
});

afterEach(async () => {
  vi.mocked(fs.mkdir).mockReset();
  vi.mocked(fs.lstat).mockReset();
  vi.unstubAllGlobals();
  await removePortablePluginFixtures();
});

function emulateClaimPlatform(platform: NodeJS.Platform = "win32"): void {
  const nativeProcess = Object.create(process) as NodeJS.Process;
  Object.defineProperty(nativeProcess, "platform", { value: platform });
  vi.stubGlobal("process", nativeProcess);
}

function deniedClaim(code = "EPERM"): Error {
  return Object.assign(new Error("Directory claim denied"), { code });
}

test.each(["appeared", "disappeared", "replaced"] as const)("a proven %s name is contention without granting ownership", async (transition) => {
  const context = await createPortablePluginFixture("memory");
  const target = join(context.stateDir, "lock");
  if (transition !== "appeared") await fs.mkdir(target);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.mkdir).mockImplementationOnce(async () => {
    if (transition !== "appeared") await actual.rename(target, `${target}.old`);
    if (transition !== "disappeared") await actual.mkdir(target);
    throw deniedClaim();
  });
  emulateClaimPlatform();
  await expect(claimStoreLockDirectory(target)).rejects.toMatchObject({ code: "EEXIST" });
  if (transition === "disappeared") {
    await expect(actual.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    return;
  }
  expect((await actual.lstat(target)).isDirectory()).toBe(true);
});

test.each(["absent", "same_identity", "before_unobservable", "after_unobservable"] as const)("preserves the original denial when %s supplies no namespace proof", async (kind) => {
  const context = await createPortablePluginFixture("memory");
  const target = join(context.stateDir, "lock");
  if (kind !== "absent") await fs.mkdir(target);
  const denied = deniedClaim();
  if (kind === "before_unobservable") vi.mocked(fs.lstat).mockRejectedValueOnce(deniedClaim("EACCES"));
  vi.mocked(fs.mkdir).mockImplementationOnce(async () => {
    if (kind === "after_unobservable") vi.mocked(fs.lstat).mockRejectedValueOnce(deniedClaim("EACCES"));
    throw denied;
  });
  emulateClaimPlatform();
  await expect(claimStoreLockDirectory(target)).rejects.toBe(denied);
});

test.each([
  { platform: "linux", code: "EPERM" },
  { platform: "win32", code: "EACCES" },
] as const)("preserves $platform $code outside the Windows pending-delete condition", async ({ platform, code }) => {
  const context = await createPortablePluginFixture("memory");
  const target = join(context.stateDir, "lock");
  const denied = deniedClaim(code);
  vi.mocked(fs.mkdir).mockRejectedValueOnce(denied);
  emulateClaimPlatform(platform);
  await expect(claimStoreLockDirectory(target)).rejects.toBe(denied);
});

test("keeps adjacent Windows file identities above Number.MAX_SAFE_INTEGER distinct", async () => {
  const context = await createPortablePluginFixture("memory");
  const target = join(context.stateDir, "lock");
  await fs.mkdir(target);
  const identity = await fs.lstat(target, { bigint: true });
  const before = Object.assign(Object.create(Object.getPrototypeOf(identity)), identity, { ino: 9007199254740992n });
  const after = Object.assign(Object.create(Object.getPrototypeOf(identity)), identity, { ino: 9007199254740993n });
  vi.mocked(fs.lstat).mockResolvedValueOnce(before).mockResolvedValueOnce(after);
  vi.mocked(fs.mkdir).mockRejectedValueOnce(deniedClaim());
  emulateClaimPlatform();
  await expect(claimStoreLockDirectory(target)).rejects.toMatchObject({ code: "EEXIST" });
});
