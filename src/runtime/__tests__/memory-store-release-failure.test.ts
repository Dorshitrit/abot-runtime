import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const lockHarness = vi.hoisted(() => ({
  acquisitionCount: 0,
  releaseCount: 0,
}));

vi.mock("../../../plugins/memory/source/store-lock.js", () => ({
  acquireStoreLock: async () => {
    lockHarness.acquisitionCount += 1;
    const acquisition = lockHarness.acquisitionCount;
    return async () => {
      lockHarness.releaseCount += 1;
      if (acquisition === 2) {
        throw new Error("forced lock release failure");
      }
    };
  },
}));

import { MemoryStore } from "../../../plugins/memory/source/store.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  lockHarness.acquisitionCount = 0;
  lockHarness.releaseCount = 0;
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("memory store mutation completion", () => {
  test("does not report mutation success before lock release succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-store-release-"));
    temporaryRoots.push(root);
    const filePath = join(root, "memory.json");
    const store = new MemoryStore({ filePath });

    await expect(
      store.add("persisted but not safely released"),
    ).rejects.toThrow("forced lock release failure");
    expect(lockHarness).toMatchObject({
      acquisitionCount: 2,
      releaseCount: 2,
    });
    await expect(
      readFile(filePath, "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toMatchObject({
      entries: [{ content: "persisted but not safely released" }],
    });
  });
});
