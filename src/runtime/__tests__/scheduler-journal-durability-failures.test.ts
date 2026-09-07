import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SchedulerStore } from "../scheduler/contracts.js";
import {
  committedCheckpointPath,
  createCheckpointFixture,
  readCheckpointManifest,
} from "./support/scheduler-checkpoint-fixture.js";

const faults = vi.hoisted(() => ({ directory: "" }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        if (String(args[0]) === faults.directory)
          throw new Error("injected_directory_sync_failure");
        await sync();
      });
      return handle;
    }),
  };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  faults.directory = "";
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function changeTitle(store: SchedulerStore, title: string) {
  await store.update((state) => {
    state.jobs[1].title = title;
  }, "active");
}

async function rejectCachedAccess(store: SchedulerStore) {
  await expect(store.read()).rejects.toThrow("directory_sync");
  await expect(store.readRuns!()).rejects.toThrow("directory_sync");
  const mutate = vi.fn();
  await expect(store.update(mutate)).rejects.toThrow("directory_sync");
  expect(mutate).not.toHaveBeenCalled();
}

test.skipIf(process.platform === "win32")(
  "transaction directory sync failure leaves the old head authoritative and permits an explicit replacement",
  async () => {
    const f = await createCheckpointFixture(cleanups);
    const owner = await f.own();
    const before = await readCheckpointManifest(f.directory);
    faults.directory = join(f.directory, before.generation);
    await expect(changeTitle(owner.store, "uncommitted")).rejects.toThrow(
      "directory_sync",
    );
    expect(await readCheckpointManifest(f.directory)).toEqual(before);
    expect(await owner.store.read()).toEqual(f.snapshot);
    faults.directory = "";
    await changeTitle(owner.store, "replacement");
    expect((await f.fresh().read()).jobs[1].title).toBe("replacement");
    expect((await readCheckpointManifest(f.directory)).sequence).toBe(
      before.sequence + 1,
    );
  },
);

test.skipIf(process.platform === "win32")(
  "checkpoint directory sync failure cannot publish a v2 upgrade",
  async () => {
    const f = await createCheckpointFixture(cleanups);
    faults.directory = join(f.directory, f.generation, "checkpoints");
    await expect(f.fresh().acquire()).rejects.toThrow("directory_sync");
    expect((await readCheckpointManifest(f.directory)).schemaVersion).toBe(2);
    expect(await f.fresh().read()).toEqual(f.snapshot);
    faults.directory = "";
    const owner = await f.own();
    expect(await owner.store.read()).toEqual(f.snapshot);
  },
);

test.skipIf(process.platform === "win32")(
  "uncertain manifest durability blocks cached state and sequence reuse until explicit reacquisition",
  async () => {
    const f = await createCheckpointFixture(cleanups);
    const owner = await f.own();
    const before = await readCheckpointManifest(f.directory);
    faults.directory = f.directory;
    await expect(
      changeTitle(owner.store, "visible publication"),
    ).rejects.toThrow("directory_sync");
    expect((await readCheckpointManifest(f.directory)).sequence).toBe(
      before.sequence + 1,
    );
    faults.directory = "";
    await rejectCachedAccess(owner.store);
    await owner.close();
    const reopened = await f.own();
    expect((await reopened.store.read()).jobs[1].title).toBe(
      "visible publication",
    );
    await changeTitle(reopened.store, "next publication");
    expect((await readCheckpointManifest(f.directory)).sequence).toBe(
      before.sequence + 2,
    );
    expect((await f.fresh().read()).jobs[1].title).toBe("next publication");
  },
);

test.skipIf(process.platform === "win32")(
  "a failed generation head sync retains both generations and a failed reacquire cannot clean them",
  async () => {
    const f = await createCheckpointFixture(cleanups);
    const owner = await f.own();
    const before = await readCheckpointManifest(f.directory);
    // Fail only after the new generation's head is visible, not its mkdir barrier.
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      await rename(...args);
      if (String(args[1]) === join(f.directory, "scheduler-journal.json"))
        faults.directory = f.directory;
    });
    await expect(
      owner.store.update((state) => {
        state.jobs = state.jobs.filter((job) => job.id !== "deleted");
        state.runs = state.runs.filter((run) => run.jobId !== "deleted");
      }),
    ).rejects.toThrow("directory_sync");
    const after = await readCheckpointManifest(f.directory);
    expect(after.generation).not.toBe(before.generation);
    const oldDirectory = join(f.directory, before.generation);
    const newDirectory = join(f.directory, after.generation);
    await expect(fs.access(oldDirectory)).resolves.toBeUndefined();
    await expect(fs.access(newDirectory)).resolves.toBeUndefined();
    await rejectCachedAccess(owner.store);
    await owner.close();
    await expect(f.fresh().acquire()).rejects.toThrow("directory_sync");
    await expect(fs.access(oldDirectory)).resolves.toBeUndefined();
    await expect(fs.access(newDirectory)).resolves.toBeUndefined();
    faults.directory = "";
    const reopened = await f.own();
    expect((await reopened.store.read()).jobs.map((job) => job.id)).toEqual([
      "retained",
    ]);
    await expect(fs.access(oldDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(newDirectory)).resolves.toBeUndefined();
  },
);

test.skipIf(process.platform === "win32")(
  "failed checkpoint head sync retains the old checkpoint and never invokes the waiting mutation",
  { timeout: 20_000 },
  async () => {
    const f = await createCheckpointFixture(cleanups);
    const owner = await f.own();
    for (let index = 0; index < 256; index++)
      await changeTitle(owner.store, `revision-${index}`);
    const before = await readCheckpointManifest(f.directory);
    faults.directory = f.directory;
    const mutate = vi.fn();
    await expect(owner.store.update(mutate)).rejects.toThrow("directory_sync");
    expect(mutate).not.toHaveBeenCalled();
    const after = await readCheckpointManifest(f.directory);
    expect(after.checkpoint!.file).not.toBe(before.checkpoint!.file);
    expect(after.sequence).toBe(before.sequence);
    await expect(
      fs.access(committedCheckpointPath(f.directory, before)),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(committedCheckpointPath(f.directory, after)),
    ).resolves.toBeUndefined();
    faults.directory = "";
    await rejectCachedAccess(owner.store);
    await owner.close();
    const reopened = await f.own();
    expect((await reopened.store.read()).jobs[1].title).toBe("revision-255");
    expect(await reopened.store.readRuns!()).toEqual(f.snapshot.runs);
  },
);
