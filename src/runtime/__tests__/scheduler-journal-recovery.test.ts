import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type {
  SchedulerJob,
  SchedulerSnapshot,
  SchedulerStore,
} from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { makeSchedulerRun } from "../scheduler/run-records.js";

const faults = vi.hoisted(() => ({ manifest: false, removal: "" }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (
        faults.manifest &&
        String(args[1]).endsWith("/scheduler-journal.json")
      )
        throw new Error("manifest_publication_failed");
      return actual.rename(...args);
    }),
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]) === faults.removal)
        throw new Error("generation_cleanup_failed");
      return actual.rm(...args);
    }),
  };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  faults.manifest = false;
  faults.removal = "";
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
});

async function fixture() {
  const directory = await fs.mkdtemp(
    join(tmpdir(), "scheduler-journal-recovery-"),
  );
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const jobs: SchedulerJob[] = ["deleted", "retained"].map((id) => ({
    id,
    sessionId: id,
    environmentId: "test",
    title: id,
    prompt: `${id}-private-prompt`,
    modelProfileId: "model",
    agentMode: "fast",
    toolPermissionMode: "full_access",
    timeZone: "UTC",
    state: "active",
    schedule: { kind: "daily", at: "09:00" },
    revision: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    nextRunAt: "2026-09-07T09:00:00.000Z",
  }));
  const runs = [
    makeSchedulerRun(jobs[0], "2026-09-06T09:00:00.000Z", "manual"),
    {
      ...makeSchedulerRun(jobs[1], "2026-09-05T09:00:00.000Z", "schedule"),
      status: "succeeded" as const,
      resultText: "retained-private-result",
    },
    {
      ...makeSchedulerRun(jobs[0], "2026-09-04T09:00:00.000Z", "schedule"),
      status: "succeeded" as const,
      resultText: "deleted-private-result",
    },
  ];
  const snapshot: SchedulerSnapshot = { schemaVersion: 1, jobs, runs };
  const legacy = join(directory, "scheduler.json");
  await fs.writeFile(legacy, JSON.stringify(snapshot));
  return { directory, legacy, snapshot };
}

async function owned(directory: string) {
  const store = createFileSchedulerStore(directory);
  let release: (() => Promise<void>) | undefined = await store.acquire();
  const close = async () => {
    const current = release;
    release = undefined;
    await current?.();
  };
  cleanups.push(close);
  return { store, close };
}
async function generation(directory: string): Promise<string> {
  return JSON.parse(
    await fs.readFile(join(directory, "scheduler-journal.json"), "utf8"),
  ).generation;
}
async function generations(directory: string) {
  return (await fs.readdir(directory))
    .filter((name) => name.startsWith("generation-"))
    .sort();
}
function deleteSession(store: SchedulerStore) {
  return store.update((state) => {
    state.jobs = state.jobs.filter((job) => job.sessionId !== "deleted");
    state.runs = state.runs.filter((run) => run.sessionId !== "deleted");
  }, "active");
}
async function expectOnlyRetainedFiles(directory: string) {
  expect(await generations(directory)).toEqual([await generation(directory)]);
  await expect(
    fs.access(join(directory, "scheduler.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const files = await fs.readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  for (const file of files) {
    if (!file.isFile()) continue;
    const text = await fs.readFile(join(file.parentPath, file.name), "utf8");
    expect(text).not.toContain("deleted-private-prompt");
    expect(text).not.toContain("deleted-private-result");
  }
}

test("migrates legacy snapshots without changing full order and persists explicit full-view reordering", async () => {
  const f = await fixture();
  expect(await createFileSchedulerStore(f.directory).read()).toEqual(
    f.snapshot,
  );
  const { store, close } = await owned(f.directory);
  expect(await store.read()).toEqual(f.snapshot);
  expect((await store.read("active")).runs).toEqual([f.snapshot.runs[0]]);
  await expect(fs.access(f.legacy)).rejects.toMatchObject({ code: "ENOENT" });
  await store.update((state) => {
    state.jobs.reverse();
    state.runs.reverse();
  });
  const reordered = {
    ...f.snapshot,
    jobs: [...f.snapshot.jobs].reverse(),
    runs: [...f.snapshot.runs].reverse(),
  };
  expect(await store.read()).toEqual(reordered);
  await close();
  expect(await store.read()).toEqual(reordered);
  const reopened = await owned(f.directory);
  expect(await reopened.store.read()).toEqual(reordered);
});

test("failed migration publication leaves legacy authoritative and restart removes the orphan generation", async () => {
  const f = await fixture();
  faults.manifest = true;
  await expect(createFileSchedulerStore(f.directory).acquire()).rejects.toThrow(
    "manifest_publication_failed",
  );
  expect(JSON.parse(await fs.readFile(f.legacy, "utf8"))).toEqual(f.snapshot);
  expect(await generations(f.directory)).toHaveLength(1);
  await expect(
    fs.access(join(f.directory, "scheduler-journal.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await createFileSchedulerStore(f.directory).read()).toEqual(
    f.snapshot,
  );
  const orphan = (await generations(f.directory))[0];
  faults.manifest = false;
  const restarted = await owned(f.directory);
  expect(await restarted.store.read()).toEqual(f.snapshot);
  expect(await generations(f.directory)).not.toContain(orphan);
  await deleteSession(restarted.store);
  expect((await restarted.store.read()).runs).toEqual([f.snapshot.runs[1]]);
  await expectOnlyRetainedFiles(f.directory);
});

test("failed compaction publication preserves the old generation and later explicit deletion removes all staging copies", async () => {
  const f = await fixture();
  const first = await owned(f.directory);
  const original = await generation(f.directory);
  faults.manifest = true;
  await expect(deleteSession(first.store)).rejects.toThrow(
    "manifest_publication_failed",
  );
  expect(await generation(f.directory)).toBe(original);
  expect(await first.store.read()).toEqual(f.snapshot);
  expect(await generations(f.directory)).toHaveLength(2);
  await first.close();
  faults.manifest = false;
  const restarted = await owned(f.directory);
  expect(await generations(f.directory)).toEqual([original]);
  expect(await restarted.store.read()).toEqual(f.snapshot);
  await deleteSession(restarted.store);
  expect((await restarted.store.read()).runs).toEqual([f.snapshot.runs[1]]);
  await expectOnlyRetainedFiles(f.directory);
});

test("failed physical cleanup preserves the new committed index and an explicit delete retries only cleanup", async () => {
  const f = await fixture();
  const first = await owned(f.directory);
  const original = await generation(f.directory);
  faults.removal = join(f.directory, original);
  await expect(deleteSession(first.store)).rejects.toThrow(
    "generation_cleanup_failed",
  );
  const committed = await generation(f.directory);
  expect(committed).not.toBe(original);
  expect((await first.store.read()).runs).toEqual([f.snapshot.runs[1]]);
  await expect(deleteSession(first.store)).rejects.toThrow(
    "generation_cleanup_failed",
  );
  expect(await generation(f.directory)).toBe(committed);
  faults.removal = "";
  await deleteSession(first.store);
  expect(await generation(f.directory)).toBe(committed);
  await expectOnlyRetainedFiles(f.directory);
  await first.close();
  expect((await createFileSchedulerStore(f.directory).read()).runs).toEqual([
    f.snapshot.runs[1],
  ]);
});

test("active/full reads and mutation results are detached while terminal transitions retain canonical order", async () => {
  const f = await fixture();
  const { store } = await owned(f.directory);
  const active = await store.read("active");
  const complete = await store.read();
  active.jobs[0].title = "outside mutation";
  active.runs[0].prompt = "outside mutation";
  complete.runs[1].resultText = "outside mutation";
  expect(await store.read()).toEqual(f.snapshot);
  let captured!: SchedulerSnapshot["runs"][number];
  const committedPending = { ...f.snapshot.runs[0], title: "Committed title" };
  await store.update((state) => {
    captured = state.runs[0];
    captured.title = committedPending.title;
  }, "active");
  captured.prompt = "escaped callback mutation";
  captured.status = "succeeded";
  expect((await store.read("active")).runs).toEqual([committedPending]);
  const returned = await store.update((state) => {
    const run = state.runs[0];
    run.status = "succeeded";
    run.resultText = "terminal result";
    return run;
  }, "active");
  returned.prompt = "outside mutation";
  expect((await store.read("active")).runs).toEqual([]);
  const expected = {
    ...committedPending,
    status: "succeeded",
    resultText: "terminal result",
  };
  expect((await store.read()).runs).toEqual([
    expected,
    ...f.snapshot.runs.slice(1),
  ]);
  const page = await store.readRuns!("deleted", { limit: 1 });
  expect(page).toEqual([expected]);
  page[0].prompt = "outside mutation";
  expect((await store.readRuns!("deleted", { limit: 1 }))[0]).toEqual(expected);
  await deleteSession(store);
  expect((await store.read()).runs).toEqual([f.snapshot.runs[1]]);
  await expectOnlyRetainedFiles(f.directory);
});
