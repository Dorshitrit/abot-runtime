import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  syncJournalDirectory,
  syncJournalDirectoryPath,
  writeJournalJson,
} from "../scheduler/journal-durability.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
});

test("Windows retains file sync and rename without attempting unsupported directory handles", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "journal-windows-"));
  cleanups.push(() => fs.rm(directory, { force: true, recursive: true }));
  const windows = Object.create(process);
  Object.defineProperty(windows, "platform", { value: "win32" });
  vi.stubGlobal("process", windows);
  await syncJournalDirectory(directory);
  await syncJournalDirectoryPath(directory);
  await writeJournalJson(join(directory, "record.json"), { saved: true });
  expect(await fs.readFile(join(directory, "record.json"), "utf8")).toBe(
    '{"saved":true}',
  );
  const opens = vi.mocked(fs.open).mock.calls;
  expect(opens).toHaveLength(1);
  expect(opens[0][1]).toBe("wx");
});

test.skipIf(process.platform === "win32")(
  "POSIX sync errors propagate and the directory handle is closed",
  async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "journal-posix-"));
    cleanups.push(() => fs.rm(directory, { force: true, recursive: true }));
    const handle = await fs.open(directory, "r");
    const closed = vi.spyOn(handle, "close");
    const failure = Object.assign(new Error("device_io_error"), {
      code: "EIO",
    });
    vi.spyOn(handle, "sync").mockRejectedValue(failure);
    vi.mocked(fs.open).mockResolvedValueOnce(handle);
    await expect(syncJournalDirectory(directory)).rejects.toBe(failure);
    expect(closed).toHaveBeenCalledOnce();
    expect(handle.fd).toBe(-1);
  },
);

test.skipIf(process.platform === "win32")(
  "an existing path is synced through every ancestor on each explicit acquisition boundary",
  async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "journal-ancestors-"));
    cleanups.push(() => fs.rm(directory, { force: true, recursive: true }));
    const nested = join(directory, "left-by-failed-mkdir", "scheduler");
    await fs.mkdir(nested, { recursive: true });
    const expected: string[] = [];
    for (let current = nested; ; current = dirname(current)) {
      expected.push(current);
      if (dirname(current) === current) break;
    }
    await syncJournalDirectoryPath(nested);
    await syncJournalDirectoryPath(nested);
    expect(vi.mocked(fs.open).mock.calls.map(([path]) => String(path))).toEqual(
      [...expected, ...expected],
    );
  },
);
