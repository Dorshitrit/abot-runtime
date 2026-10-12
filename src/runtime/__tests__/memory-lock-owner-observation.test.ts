import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { openLockOwnerFile } from "../../../plugins/memory/source/lock-owner-file.js";

vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), open: vi.fn() }));

const namedInfo = vi.mocked(lstat);
const openFile = vi.mocked(open);
const ownerPath = "memory.json.lock/lease/owner-fixture.json";

function regular(ino = 2n): BigIntStats {
  return { dev: 1n, ino, isFile: () => true } as BigIntStats;
}

function denial(code = "EPERM"): Error & { code: string } {
  return Object.assign(new Error(`fixture_${code}`), { code });
}

function ownerHandle() {
  const stat = vi.fn().mockResolvedValue(regular());
  const close = vi.fn().mockResolvedValue(undefined);
  const handle = { stat, close } as unknown as FileHandle;
  openFile.mockResolvedValue(handle);
  namedInfo.mockResolvedValue(regular());
  return { handle, stat, close };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("process", { ...process, platform: "win32" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("a stable regular owner returns its verified handle with no-follow when available", async () => {
  const { handle, close } = ownerHandle();
  await expect(openLockOwnerFile(ownerPath)).resolves.toBe(handle);
  const flags = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_RDONLY | constants.O_NOFOLLOW
    : constants.O_RDONLY;
  expect(openFile).toHaveBeenCalledExactlyOnceWith(ownerPath, flags);
  expect(namedInfo).toHaveBeenCalledTimes(2);
  expect(close).not.toHaveBeenCalled();
});

test("pending deletion is observed again only after closing the failed observer handle", async () => {
  const { close } = ownerHandle();
  const original = denial();
  const missing = denial("ENOENT");
  const order: string[] = [];
  let finishClose!: () => void;
  let startedClose!: () => void;
  const closing = new Promise<void>((resolve) => { finishClose = resolve; });
  const started = new Promise<void>((resolve) => { startedClose = resolve; });
  close.mockImplementation(async () => {
    order.push("close started");
    startedClose();
    await closing;
    order.push("close finished");
  });
  namedInfo.mockResolvedValueOnce(regular()).mockRejectedValueOnce(original)
    .mockImplementationOnce(async () => {
      order.push("fresh observation");
      throw missing;
    });

  const result = openLockOwnerFile(ownerPath).catch((error: unknown) => error);
  await started;
  expect(namedInfo).toHaveBeenCalledTimes(2);
  finishClose();
  expect(await result).toBe(missing);
  expect(order).toEqual(["close started", "close finished", "fresh observation"]);
  expect(openFile).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

test.each(["denied", "same owner", "changed owner"] as const)(
  "Windows preserves the original denial when a fresh observation finds %s",
  async (outcome) => {
    const { close } = ownerHandle();
    const original = denial();
    namedInfo.mockResolvedValueOnce(regular()).mockRejectedValueOnce(original);
    if (outcome === "denied") namedInfo.mockRejectedValueOnce(denial());
    else namedInfo.mockResolvedValueOnce(regular(outcome === "same owner" ? 2n : 3n));
    await expect(openLockOwnerFile(ownerPath)).rejects.toBe(original);
    expect(close).toHaveBeenCalledTimes(1);
    expect(namedInfo).toHaveBeenCalledTimes(3);
    expect(openFile).toHaveBeenCalledTimes(1);
  },
);

test.each([
  ["linux", "EPERM"],
  ["darwin", "EPERM"],
  ["win32", "EACCES"],
])("%s %s closes the observer and propagates without another observation", async (platform, code) => {
  vi.stubGlobal("process", { ...process, platform });
  const { close } = ownerHandle();
  const error = denial(code);
  namedInfo.mockResolvedValueOnce(regular()).mockRejectedValueOnce(error);
  await expect(openLockOwnerFile(ownerPath)).rejects.toBe(error);
  expect(close).toHaveBeenCalledTimes(1);
  expect(namedInfo).toHaveBeenCalledTimes(2);
  expect(openFile).toHaveBeenCalledTimes(1);
});

test("a nonregular named owner is rejected before opening", async () => {
  ownerHandle();
  namedInfo.mockResolvedValueOnce({ ...regular(), isFile: () => false } as BigIntStats);
  await expect(openLockOwnerFile(ownerPath)).rejects.toMatchObject({ code: "ELOOP" });
  expect(openFile).not.toHaveBeenCalled();
});

test.each(["opened handle", "named file"] as const)(
  "a changed %s identity is rejected and its observer handle is closed",
  async (changed) => {
    const { stat, close } = ownerHandle();
    if (changed === "opened handle") stat.mockResolvedValueOnce(regular(3n));
    else namedInfo.mockResolvedValueOnce(regular()).mockResolvedValueOnce(regular(3n));
    await expect(openLockOwnerFile(ownerPath)).rejects.toMatchObject({ code: "EAGAIN" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(namedInfo).toHaveBeenCalledTimes(2);
  },
);
