import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  checkpointTransactionPath,
  committedCheckpointPath,
  createCheckpointFixture,
  readCheckpointManifest,
} from "./support/scheduler-checkpoint-fixture.js";

const events = vi.hoisted(
  () =>
    [] as Array<{
      kind: string;
      path: string;
      source?: string;
    }>,
);
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      const directory = (await handle.stat()).isDirectory();
      const sync = handle.sync.bind(handle);
      const write = handle.writeFile.bind(handle);
      handle.sync = async () => {
        await sync();
        events.push({ kind: directory ? "directory-sync" : "file-sync", path });
      };
      handle.writeFile = async (
        ...writeArgs: Parameters<typeof handle.writeFile>
      ) => {
        await write(...writeArgs);
        events.push({ kind: "write", path });
      };
      return handle;
    }),
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      events.push({
        kind: "rename",
        path: String(args[1]),
        source: String(args[0]),
      });
    }),
    mkdir: vi.fn(async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      events.push({ kind: "mkdir", path: String(args[0]) });
      return result;
    }),
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      await actual.rm(...args);
      events.push({ kind: "remove", path: String(args[0]) });
    }),
  };
});

const cleanups: Array<() => Promise<void>> = [];
const directorySyncTest = test.skipIf(process.platform === "win32");
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  events.length = 0;
  vi.restoreAllMocks();
});

function successfulEvent(kind: string, path: string, after = -1): number {
  const index = events.findIndex(
    (event, position) =>
      position > after && event.kind === kind && event.path === path,
  );
  expect(index, `${kind} ${path} after event ${after}`).toBeGreaterThan(after);
  return index;
}

function durableFilePublication(path: string) {
  const renamed = successfulEvent("rename", path);
  const temporary = events[renamed].source!;
  const written = successfulEvent("write", temporary);
  const contentSynced = successfulEvent("file-sync", temporary, written);
  expect(contentSynced).toBeLessThan(renamed);
  const directorySynced = successfulEvent(
    "directory-sync",
    dirname(path),
    renamed,
  );
  return { renamed, directorySynced };
}

directorySyncTest(
  "an ordinary transaction is durable before its manifest and update success",
  async () => {
    const f = await createCheckpointFixture(cleanups);
    const owner = await f.own();
    const before = await readCheckpointManifest(f.directory);
    events.length = 0;
    await owner.store.update((state) => {
      state.jobs[1].title = "Committed title";
    }, "active");
    events.push({ kind: "success", path: f.directory });
    const transaction = durableFilePublication(
      checkpointTransactionPath(
        f.directory,
        before.generation,
        before.sequence + 1,
      ),
    );
    const manifest = durableFilePublication(
      join(f.directory, "scheduler-journal.json"),
    );
    expect(transaction.directorySynced).toBeLessThan(manifest.renamed);
    expect(manifest.directorySynced).toBeLessThan(
      successfulEvent("success", f.directory),
    );
    expect((await f.fresh().read()).jobs[1].title).toBe("Committed title");
  },
);

directorySyncTest(
  "reopening existing v3 syncs selected directories before cleanup without rewriting or scanning transactions",
  async () => {
    const f = await createCheckpointFixture(cleanups);
    const owner = await f.own();
    const head = await readCheckpointManifest(f.directory);
    await owner.close();
    const generation = join(f.directory, head.generation);
    const reads = vi.spyOn(fs, "readFile");
    const listings = vi.spyOn(fs, "readdir");
    events.length = 0;
    await f.own();
    events.push({ kind: "success", path: f.directory });
    const checkpointSynced = successfulEvent(
      "directory-sync",
      dirname(committedCheckpointPath(f.directory, head)),
    );
    const generationSynced = successfulEvent(
      "directory-sync",
      generation,
      checkpointSynced,
    );
    const rootSynced = successfulEvent(
      "directory-sync",
      f.directory,
      generationSynced,
    );
    const firstCleanup = events.findIndex((event) => event.kind === "remove");
    expect(firstCleanup).toBeGreaterThan(rootSynced);
    expect(successfulEvent("success", f.directory)).toBeGreaterThan(rootSynced);
    expect(
      events
        .filter((event) => ["write", "rename"].includes(event.kind))
        .filter((event) =>
          /\/(generation-|scheduler-journal\.json)/.test(event.path),
        ),
    ).toEqual([]);
    expect(
      reads.mock.calls.some(([path]) => dirname(String(path)) === generation),
    ).toBe(false);
    expect(listings.mock.calls.map(([path]) => String(path))).not.toContain(
      generation,
    );
  },
);

directorySyncTest(
  "checkpoint upgrade syncs its new directory and parent before manifest publication and acquire success",
  async () => {
    const f = await createCheckpointFixture(cleanups);
    events.length = 0;
    await f.own();
    events.push({ kind: "success", path: f.directory });
    const head = await readCheckpointManifest(f.directory);
    const checkpoint = committedCheckpointPath(f.directory, head);
    const checkpointCommit = durableFilePublication(checkpoint);
    const manifest = durableFilePublication(
      join(f.directory, "scheduler-journal.json"),
    );
    const directoryCreated = successfulEvent("mkdir", dirname(checkpoint));
    const parentSynced = successfulEvent(
      "directory-sync",
      join(f.directory, head.generation),
      directoryCreated,
    );
    expect(parentSynced).toBeLessThan(manifest.renamed);
    expect(checkpointCommit.directorySynced).toBeLessThan(manifest.renamed);
    expect(manifest.directorySynced).toBeLessThan(
      successfulEvent("success", f.directory),
    );
    expect(await f.fresh().read()).toEqual(f.snapshot);
  },
);

directorySyncTest(
  "deletion durably installs a new generation before removing the old generation",
  async () => {
    const f = await createCheckpointFixture(cleanups);
    const owner = await f.own();
    events.length = 0;
    await owner.store.update((state) => {
      state.jobs = state.jobs.filter((job) => job.id !== "deleted");
      state.runs = state.runs.filter((run) => run.jobId !== "deleted");
    }, "active");
    events.push({ kind: "success", path: f.directory });
    const head = await readCheckpointManifest(f.directory);
    expect(head.generation).not.toBe(f.generation);
    const generationPath = join(f.directory, head.generation);
    const manifest = durableFilePublication(
      join(f.directory, "scheduler-journal.json"),
    );
    const generationCreated = successfulEvent("mkdir", generationPath);
    const generationParentSynced = successfulEvent(
      "directory-sync",
      f.directory,
      generationCreated,
    );
    expect(generationParentSynced).toBeLessThan(manifest.renamed);
    for (let sequence = 1; sequence <= head.sequence; sequence++) {
      const transaction = durableFilePublication(
        checkpointTransactionPath(f.directory, head.generation, sequence),
      );
      expect(transaction.directorySynced).toBeLessThan(manifest.renamed);
    }
    const checkpoint = committedCheckpointPath(f.directory, head);
    const checkpointCommit = durableFilePublication(checkpoint);
    const checkpointCreated = successfulEvent("mkdir", dirname(checkpoint));
    const checkpointParentSynced = successfulEvent(
      "directory-sync",
      generationPath,
      checkpointCreated,
    );
    expect(checkpointParentSynced).toBeLessThan(manifest.renamed);
    expect(checkpointCommit.directorySynced).toBeLessThan(manifest.renamed);
    expect(
      successfulEvent("remove", join(f.directory, f.generation)),
    ).toBeGreaterThan(manifest.directorySynced);
    expect(manifest.directorySynced).toBeLessThan(
      successfulEvent("success", f.directory),
    );
    expect((await f.fresh().read()).runs).toEqual([f.snapshot.runs[1]]);
  },
);

directorySyncTest(
  "checkpoint rollover keeps the previous checkpoint until the manifest directory sync completes",
  async () => {
    const f = await createCheckpointFixture(cleanups);
    const owner = await f.own();
    const before = await readCheckpointManifest(f.directory);
    await owner.close();
    // Seed a valid bounded suffix without performing hundreds of unrelated syncs.
    for (let offset = 1; offset <= 256; offset++) {
      await fs.writeFile(
        checkpointTransactionPath(
          f.directory,
          before.generation,
          before.sequence + offset,
        ),
        JSON.stringify({
          version: 1,
          jobs: [{ ...f.snapshot.jobs[1], title: `Revision ${offset}` }],
          runs: [],
          deletedJobs: [],
          deletedRuns: [],
        }),
      );
    }
    await fs.writeFile(
      join(f.directory, "scheduler-journal.json"),
      JSON.stringify({
        ...before,
        sequence: before.sequence + 256,
      }),
    );
    events.length = 0;
    await f.own();
    events.push({ kind: "success", path: f.directory });
    const head = await readCheckpointManifest(f.directory);
    const checkpoint = durableFilePublication(
      committedCheckpointPath(f.directory, head),
    );
    const manifest = durableFilePublication(
      join(f.directory, "scheduler-journal.json"),
    );
    expect(checkpoint.directorySynced).toBeLessThan(manifest.renamed);
    const removed = successfulEvent(
      "remove",
      committedCheckpointPath(f.directory, before),
    );
    expect(removed).toBeGreaterThan(manifest.directorySynced);
    expect(manifest.directorySynced).toBeLessThan(
      successfulEvent("success", f.directory),
    );
    expect((await f.fresh().read()).runs).toEqual(f.snapshot.runs);
  },
);
