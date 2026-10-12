import * as fs from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { syncSetupEditFile } from "../../web-ui/local-runtime/runtime-setup-edit-files.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  open: vi.fn(),
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.resetAllMocks();
});

test("Windows synchronizes updated files with a writable handle", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const handle = { sync: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const open = vi
    .spyOn(fs, "open")
    .mockResolvedValue(handle as unknown as fs.FileHandle);
  await syncSetupEditFile("fixture.config.json");
  expect(open).toHaveBeenCalledExactlyOnceWith("fixture.config.json", "r+");
  expect(handle.sync).toHaveBeenCalledOnce();
  expect(handle.close).toHaveBeenCalledOnce();
});

test("Windows closes the writable handle if synchronization fails", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const failure = new Error("fixture disk sync failed");
  const handle = {
    sync: vi.fn(async () => {
      throw failure;
    }),
    close: vi.fn(async () => {}),
  };
  vi.mocked(fs.open).mockResolvedValue(handle as unknown as fs.FileHandle);
  await expect(syncSetupEditFile("fixture.config.json")).rejects.toBe(failure);
  expect(handle.close).toHaveBeenCalledOnce();
});
