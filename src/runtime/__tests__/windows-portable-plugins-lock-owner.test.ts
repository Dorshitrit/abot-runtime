import * as fs from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { openLockOwnerFile } from "../../../plugins/memory/source/lock-owner-file.js";
import { createPortablePluginFixture, removePortablePluginFixtures } from "./windows-portable-plugins-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await removePortablePluginFixtures();
});

test("opens a regular owner record and rejects a directory junction", async () => {
  const context = await createPortablePluginFixture("memory");
  const ownerPath = join(context.stateDir, "owner.json");
  await fs.writeFile(ownerPath, "owner");
  const handle = await openLockOwnerFile(ownerPath);
  try {
    expect(await handle.readFile("utf8")).toBe("owner");
  } finally {
    await handle.close();
  }
  const junction = join(context.stateDir, "owner-junction");
  await fs.symlink(context.stateDir, junction, "junction");
  await expect(openLockOwnerFile(junction)).rejects.toMatchObject({ code: "ELOOP" });
});

test("rejects an owner-file symlink when the host permits creating one", async ({ skip }) => {
  const context = await createPortablePluginFixture("memory");
  const target = join(context.stateDir, "target.json");
  const link = join(context.stateDir, "owner-link.json");
  await fs.writeFile(target, "owner");
  try {
    await fs.symlink(target, link, "file");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
      skip("Windows file symlink privilege is unavailable; junction rejection is tested separately.");
      return;
    }
    throw error;
  }
  await expect(openLockOwnerFile(link)).rejects.toMatchObject({ code: "ELOOP" });
  expect(await fs.readFile(target, "utf8")).toBe("owner");
});

test("rejects an owner replaced between the named check and open", async () => {
  const context = await createPortablePluginFixture("memory");
  const ownerPath = join(context.stateDir, "owner.json");
  await fs.writeFile(ownerPath, "original");
  const { open: nativeOpen } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.open).mockImplementationOnce(async (path, flags, mode) => {
    await fs.rename(ownerPath, `${ownerPath}.old`);
    await fs.writeFile(ownerPath, "replacement");
    return nativeOpen(path, flags, mode);
  });
  await expect(openLockOwnerFile(ownerPath)).rejects.toMatchObject({ code: "EAGAIN" });
});

function emulateWindowsOwnerOpen(): void {
  const nativeProcess = Object.create(process) as NodeJS.Process;
  Object.defineProperty(nativeProcess, "platform", { value: "win32" });
  vi.stubGlobal("process", nativeProcess);
}

test("classifies a Windows owner-open denial as absent only after observing its deletion", async () => {
  const context = await createPortablePluginFixture("memory");
  const ownerPath = join(context.stateDir, "owner.json");
  await fs.writeFile(ownerPath, "original");
  emulateWindowsOwnerOpen();
  vi.mocked(fs.open).mockImplementationOnce(async () => {
    await fs.unlink(ownerPath);
    throw Object.assign(new Error("Windows pending deletion"), { code: "EPERM" });
  });
  await expect(openLockOwnerFile(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("preserves a Windows permission denial while the observed owner still exists", async () => {
  const context = await createPortablePluginFixture("memory");
  const ownerPath = join(context.stateDir, "owner.json");
  await fs.writeFile(ownerPath, "original");
  emulateWindowsOwnerOpen();
  const denied = Object.assign(new Error("Permission denied"), { code: "EPERM" });
  vi.mocked(fs.open).mockRejectedValueOnce(denied);
  await expect(openLockOwnerFile(ownerPath)).rejects.toBe(denied);
  expect(await fs.readFile(ownerPath, "utf8")).toBe("original");
});

test("does not accept a replacement owner after a Windows open denial", async () => {
  const context = await createPortablePluginFixture("memory");
  const ownerPath = join(context.stateDir, "owner.json");
  await fs.writeFile(ownerPath, "original");
  emulateWindowsOwnerOpen();
  vi.mocked(fs.open).mockImplementationOnce(async () => {
    await fs.rename(ownerPath, `${ownerPath}.old`);
    await fs.writeFile(ownerPath, "replacement");
    throw Object.assign(new Error("Windows pending deletion"), { code: "EPERM" });
  });
  await expect(openLockOwnerFile(ownerPath)).rejects.toMatchObject({ code: "EAGAIN" });
  expect(await fs.readFile(ownerPath, "utf8")).toBe("replacement");
});
