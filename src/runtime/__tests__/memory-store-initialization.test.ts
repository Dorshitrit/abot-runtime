import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const lockHarness = vi.hoisted(() => ({
  acquisitionCount: 0,
  failuresRemaining: 1,
}));

vi.mock("../../../plugins/memory/source/store-lock.js", () => ({
  acquireStoreLock: async () => {
    lockHarness.acquisitionCount += 1;
    if (lockHarness.failuresRemaining > 0) {
      lockHarness.failuresRemaining -= 1;
      throw new Error("forced transient lock acquisition failure");
    }
    return async () => undefined;
  },
}));

import { MemoryStore } from "../../../plugins/memory/source/store.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  lockHarness.acquisitionCount = 0;
  lockHarness.failuresRemaining = 1;
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("memory store initialization", () => {
  test("retries after a transient initialization promise rejects", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-store-initialization-"));
    temporaryRoots.push(root);
    const store = new MemoryStore({ filePath: join(root, "memory.json") });

    const initialAttempts = await Promise.allSettled([
      store.read(),
      store.read(),
    ]);
    expect(initialAttempts).toHaveLength(2);
    for (const result of initialAttempts) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({
          message: "forced transient lock acquisition failure",
        });
      }
    }
    expect(lockHarness.acquisitionCount).toBe(1);

    await expect(store.read()).resolves.toEqual({
      entries: [],
      nextSequence: 1,
    });
    expect(lockHarness.acquisitionCount).toBe(2);
  });
});
