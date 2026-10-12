import * as fs from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readOwnerRecord } from "../adapters/long-term-memory/file-lock/owner-record.js";

vi.mock("node:fs/promises", () => ({ open: vi.fn(), lstat: vi.fn() }));

const token = "00000000-0000-4000-8000-000000000001";
const entry = `owner-${token}.json`;
const denied = Object.assign(new Error("Owner access denied"), { code: "EPERM" });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("process", { ...process, platform: "win32" });
  vi.mocked(fs.open).mockRejectedValue(denied);
});
afterEach(() => vi.unstubAllGlobals());

test("a Windows owner that disappeared during open stays unreclaimable for this observation", async () => {
  vi.mocked(fs.lstat).mockRejectedValue(Object.assign(new Error("Gone"), { code: "ENOENT" }));
  await expect(readOwnerRecord("lock", entry, token, 10)).resolves.toEqual({
    kind: "directory", modifiedAtMs: 10, hasLeaseDirectory: true, reclaimable: false,
  });
  expect(fs.open).toHaveBeenCalledOnce();
  expect(fs.lstat).toHaveBeenCalledOnce();
  expect(vi.mocked(fs.lstat).mock.calls[0][0]).toBe(vi.mocked(fs.open).mock.calls[0][0]);
});

test.each(["exists", "denied", "io failure"])("preserves the original Windows denial when the owner %s", async (observation) => {
  if (observation === "exists") vi.mocked(fs.lstat).mockResolvedValue({} as Awaited<ReturnType<typeof fs.lstat>>);
  else vi.mocked(fs.lstat).mockRejectedValue(Object.assign(new Error("Observation failed"), {
    code: observation === "denied" ? "EPERM" : "EIO",
  }));
  await expect(readOwnerRecord("lock", entry, token, 10)).rejects.toBe(denied);
  expect(fs.open).toHaveBeenCalledOnce();
});

test.each([
  ["linux", "EPERM"], ["darwin", "EPERM"], ["win32", "EACCES"], ["win32", "EIO"],
])("%s preserves %s without reclassifying it", async (platform, code) => {
  vi.stubGlobal("process", { ...process, platform });
  const failure = Object.assign(new Error(code), { code });
  vi.mocked(fs.open).mockRejectedValue(failure);
  await expect(readOwnerRecord("lock", entry, token, 10)).rejects.toBe(failure);
  expect(fs.lstat).not.toHaveBeenCalled();
});
