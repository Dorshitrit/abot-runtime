import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type {
  SchedulerSnapshot,
  SchedulerStore,
} from "../scheduler/contracts.js";
import {
  checkpointTransactionPath,
  committedCheckpointPath,
  createCheckpointFixture,
  readCheckpointManifest,
} from "./support/scheduler-checkpoint-fixture.js";

const faults = vi.hoisted(() => ({
  renamePath: "",
  readPath: "",
  entered: () => {},
  waiting: Promise.resolve(),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]) === faults.renamePath)
        throw new Error("checkpoint_pointer_publication_failed");
      return actual.rename(...args);
    }),
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === faults.readPath) {
        faults.readPath = "";
        faults.entered();
        await faults.waiting;
      }
      return actual.readFile(...args);
    }),
  };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  faults.renamePath = "";
  faults.readPath = "";
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
});

function holdCheckpointRead(path: string) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  faults.readPath = path;
  faults.entered = enter;
  faults.waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanups.push(async () => release());
  return { entered, release };
}

async function changeTitle(store: SchedulerStore, title: string) {
  await store.update((state) => {
    state.jobs[1].title = title;
  }, "active");
}

async function advanceCheckpointSuffix(store: SchedulerStore, count: number) {
  for (let index = 0; index < count; index++)
    await changeTitle(store, `revision-${index}`);
}

test("failed head publication leaves its transaction invisible and reusable by the next explicit mutation", async () => {
  const f = await createCheckpointFixture(cleanups);
  const owner = await f.own();
  const before = await readCheckpointManifest(f.directory);
  faults.renamePath = join(f.directory, "scheduler-journal.json");
  await expect(changeTitle(owner.store, "uncommitted")).rejects.toThrow(
    "checkpoint_pointer_publication_failed",
  );
  const uncommittedPath = checkpointTransactionPath(
    f.directory,
    before.generation,
    before.sequence + 1,
  );
  expect(await fs.readFile(uncommittedPath, "utf8")).toContain("uncommitted");
  await fs.writeFile(uncommittedPath, "{invalid-uncommitted-json");
  expect(await f.fresh().read()).toEqual(f.snapshot);
  expect(await readCheckpointManifest(f.directory)).toEqual(before);
  await owner.close();
  faults.renamePath = "";
  const reopened = await f.own();
  expect(await reopened.store.read()).toEqual(f.snapshot);
  await changeTitle(reopened.store, "committed replacement");
  expect((await f.fresh().read()).jobs[1].title).toBe("committed replacement");
  expect((await f.fresh().read()).runs).toEqual(f.snapshot.runs);
  expect((await readCheckpointManifest(f.directory)).sequence).toBe(
    before.sequence + 1,
  );
});

test("failed v2 upgrade publication preserves the authoritative source and does not revive later deletion", async () => {
  const f = await createCheckpointFixture(cleanups);
  faults.renamePath = join(f.directory, "scheduler-journal.json");
  await expect(f.fresh().acquire()).rejects.toThrow(
    "checkpoint_pointer_publication_failed",
  );
  expect((await readCheckpointManifest(f.directory)).schemaVersion).toBe(2);
  expect(await f.fresh().read()).toEqual(f.snapshot);
  faults.renamePath = "";
  const owner = await f.own();
  await owner.store.update((state) => {
    state.jobs = state.jobs.filter((job) => job.id !== "deleted");
    state.runs = state.runs.filter((run) => run.jobId !== "deleted");
  }, "active");
  await owner.close();
  expect(await f.fresh().read()).toEqual({
    schemaVersion: 1,
    jobs: [f.snapshot.jobs[1]],
    runs: [f.snapshot.runs[1]],
  });
});

test(
  "an unowned reader restarts when checkpoint retirement removes its captured metadata file",
  { timeout: 20_000 },
  async () => {
    const f = await createCheckpointFixture(cleanups);
    const owner = await f.own();
    await advanceCheckpointSuffix(owner.store, 256);
    const old = await readCheckpointManifest(f.directory);
    const oldPath = committedCheckpointPath(f.directory, old);
    const gate = holdCheckpointRead(oldPath);
    const reading = f
      .fresh()
      .read("active")
      .catch((error: unknown) => error);
    await gate.entered;
    try {
      await changeTitle(owner.store, "after checkpoint retirement");
      const current = await readCheckpointManifest(f.directory);
      expect(current.generation).toBe(old.generation);
      expect(current.checkpoint!.file).not.toBe(old.checkpoint!.file);
      await expect(fs.access(oldPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      gate.release();
      expect(await reading).toEqual(await owner.store.read("active"));
    } finally {
      gate.release();
      await reading;
    }
  },
);

test(
  "failed checkpoint publication cannot invoke or partially commit the waiting mutation",
  { timeout: 20_000 },
  async () => {
    const f = await createCheckpointFixture(cleanups);
    const owner = await f.own();
    await advanceCheckpointSuffix(owner.store, 256);
    const before = await owner.store.read();
    const manifest = await readCheckpointManifest(f.directory);
    faults.renamePath = join(f.directory, "scheduler-journal.json");
    const mutation = vi.fn((state: SchedulerSnapshot) => {
      state.jobs[1].title = "never committed";
    });
    await expect(owner.store.update(mutation, "active")).rejects.toThrow(
      "checkpoint_pointer_publication_failed",
    );
    expect(mutation).not.toHaveBeenCalled();
    expect(await readCheckpointManifest(f.directory)).toEqual(manifest);
    expect(await f.fresh().read()).toEqual(before);
    faults.renamePath = "";
    await changeTitle(owner.store, "next explicit update");
    expect((await f.fresh().read()).jobs[1].title).toBe("next explicit update");
  },
);

test.each([
  ["checkpoint", "missing"],
  ["checkpoint", "corrupt"],
  ["tail", "missing"],
  ["tail", "corrupt"],
])("a %s that is %s in committed state fails closed", async (part, damage) => {
  const f = await createCheckpointFixture(cleanups);
  const owner = await f.own();
  await changeTitle(owner.store, "committed tail");
  const manifest = await readCheckpointManifest(f.directory);
  expect(manifest.schemaVersion).toBe(3);
  const path =
    part === "checkpoint"
      ? committedCheckpointPath(f.directory, manifest)
      : checkpointTransactionPath(
          f.directory,
          manifest.generation,
          manifest.sequence,
        );
  await owner.close();
  if (damage === "missing") await fs.rm(path);
  if (damage === "corrupt") await fs.writeFile(path, "{invalid-json");
  await expect(f.fresh().read("active")).rejects.toThrow();
  await expect(f.fresh().acquire()).rejects.toThrow();
});

test(
  "checkpoint reuse retains terminal payloads until explicit session deletion removes them",
  { timeout: 20_000 },
  async () => {
    const f = await createCheckpointFixture(cleanups);
    const owner = await f.own();
    await advanceCheckpointSuffix(owner.store, 514);
    expect(await f.fresh().readRuns!()).toEqual(f.snapshot.runs);
    await owner.store.update((state) => {
      state.jobs = state.jobs.filter((job) => job.id !== "deleted");
      state.runs = state.runs.filter((run) => run.jobId !== "deleted");
    }, "active");
    await owner.close();
    expect(await f.fresh().readRuns!()).toEqual([f.snapshot.runs[1]]);
    const entries = await fs.readdir(f.directory, {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const text = await fs.readFile(
        join(entry.parentPath, entry.name),
        "utf8",
      );
      expect(text).not.toContain("deleted-private-prompt");
      expect(text).not.toContain("deleted-private-result");
    }
  },
);

test("corrupt old terminal payload is validated only when that history is requested", async () => {
  const f = await createCheckpointFixture(cleanups);
  const owner = await f.own();
  const manifest = await readCheckpointManifest(f.directory);
  expect(manifest.schemaVersion).toBe(3);
  await owner.close();
  await fs.writeFile(
    checkpointTransactionPath(f.directory, manifest.generation, 2),
    "{invalid-json",
  );
  expect(await f.fresh().read("active")).toEqual({ ...f.snapshot, runs: [] });
  await expect(f.fresh().readRuns!("retained")).rejects.toThrow();
});
