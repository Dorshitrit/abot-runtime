import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SchedulerJob, SchedulerRun } from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { SchedulerJournalIndex } from "../scheduler/journal-index.js";
import { journalTransactionName } from "../scheduler/journal-files.js";
import type { SchedulerTransaction } from "../scheduler/journal-transaction.js";
import { makeSchedulerRun } from "../scheduler/run-records.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), "journal-validation-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createFileSchedulerStore(directory);
  let release: (() => Promise<void>) | undefined = await store.acquire();
  const close = async () => {
    const current = release;
    release = undefined;
    await current?.();
  };
  cleanups.push(close);
  const job: SchedulerJob = {
    id: "job",
    sessionId: "session",
    environmentId: "test",
    title: "Daily summary",
    prompt: "Summarize",
    modelProfileId: "model",
    agentMode: "fast",
    toolPermissionMode: "full_access",
    timeZone: "UTC",
    state: "active",
    schedule: { kind: "daily", at: "09:00" },
    revision: 2,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    nextRunAt: "2026-09-07T09:00:00.000Z",
  };
  const run: SchedulerRun = {
    ...makeSchedulerRun(job, "2026-09-06T09:00:00.000Z", "schedule"),
    status: "succeeded",
    resultText: "Retained history",
  };
  await store.update((state) => {
    state.jobs.push(job);
    state.runs.push(run);
  });
  const manifest = JSON.parse(
    await fs.readFile(join(directory, "scheduler-journal.json"), "utf8"),
  );
  const generation = join(directory, manifest.generation);
  const entries = (await fs.readdir(generation)).sort();
  const file = join(generation, journalTransactionName(manifest.sequence));
  const transaction = JSON.parse(
    await fs.readFile(file, "utf8"),
  ) as SchedulerTransaction;
  return {
    directory,
    store,
    close,
    job,
    run,
    generation,
    entries,
    file,
    transaction,
  };
}

const malformedTransactions: Array<
  [string, (tx: SchedulerTransaction) => void]
> = [
  [
    "duplicate jobs",
    (tx) => {
      tx.jobs.push({ ...tx.jobs[0] });
    },
  ],
  [
    "duplicate runs",
    (tx) => {
      tx.runs.push({ ...tx.runs[0] });
    },
  ],
  [
    "upserted and deleted job",
    (tx) => {
      tx.deletedJobs.push(tx.jobs[0].id);
      tx.runs = [];
      delete tx.runOrder;
    },
  ],
  [
    "upserted and deleted run",
    (tx) => {
      tx.deletedRuns.push(tx.runs[0].id);
    },
  ],
];

test.each(malformedTransactions)(
  "reopening rejects %s within one journal transaction",
  async (_name, corrupt) => {
    const f = await fixture();
    await f.close();
    corrupt(f.transaction);
    await fs.writeFile(f.file, JSON.stringify(f.transaction));
    await expect(createFileSchedulerStore(f.directory).read()).rejects.toThrow(
      "scheduler_store_corrupt",
    );
  },
);

test.each([
  ["sessionId", "other-session"],
  ["environmentId", "other-environment"],
  ["revision", 1],
] as const)(
  "active-view %s change cannot invalidate archived ownership or commit to disk",
  async (field, value) => {
    const f = await fixture();
    await expect(
      f.store.update((state) => {
        Object.assign(state.jobs[0], { [field]: value });
      }, "active"),
    ).rejects.toThrow("scheduler_store_corrupt");
    expect((await fs.readdir(f.generation)).sort()).toEqual(f.entries);
    expect(await f.store.read()).toEqual({
      schemaVersion: 1,
      jobs: [f.job],
      runs: [f.run],
    });
    await f.close();
    expect(await createFileSchedulerStore(f.directory).read()).toEqual({
      schemaVersion: 1,
      jobs: [f.job],
      runs: [f.run],
    });
  },
);

test.each([
  ["jobId", "other-job"],
  ["sessionId", "other-session"],
  ["environmentId", "other-environment"],
  ["jobRevision", 1],
  ["scheduledAt", "2026-09-06T10:00:00.000Z"],
  ["status", "running"],
  ["requestId", "other-request"],
] as const)(
  "archived payload with changed %s cannot escape its indexed identity",
  async (field, value) => {
    const f = await fixture();
    Object.assign(f.transaction.runs[0], { [field]: value });
    await fs.writeFile(f.file, JSON.stringify(f.transaction));
    await expect(f.store.readRuns!(f.job.id, { limit: 1 })).rejects.toThrow(
      "scheduler_store_corrupt",
    );
  },
);

test("metadata-only Job changes and revision increases need no archived payload access", async () => {
  const f = await fixture();
  await fs.rename(f.file, `${f.file}.temporarily-unreadable`);
  await expect(
    f.store.update((state) => {
      state.jobs[0].title = "Updated title";
      state.jobs[0].revision += 1;
      state.jobs[0].nextRunAt = "2026-09-08T09:00:00.000Z";
    }, "active"),
  ).resolves.toBeUndefined();
  await fs.rename(`${f.file}.temporarily-unreadable`, f.file);
  expect((await f.store.read()).runs).toEqual([f.run]);
});

test("prospective validation permits a coordinated run rebind or removal and apply never partially mutates invalid ownership", async () => {
  const f = await fixture();
  const index = new SchedulerJournalIndex();
  index.apply(f.transaction, f.file);
  const changedJob = { ...f.job, sessionId: "new-session" };
  const changedRun = { ...f.run, sessionId: "new-session" };
  const delta: SchedulerTransaction = {
    version: 1,
    jobs: [changedJob],
    runs: [],
    deletedJobs: [],
    deletedRuns: [],
  };
  expect(() => index.apply(delta, "uncommitted")).toThrow(
    "scheduler_store_corrupt",
  );
  expect((await index.snapshot("active")).jobs).toEqual([f.job]);
  expect(() => index.validate({ ...delta, runs: [changedRun] })).not.toThrow();
  expect(() =>
    index.validate({ ...delta, deletedRuns: [f.run.id] }),
  ).not.toThrow();
});

test("active updates preserve run order and explicit reordering applies to active snapshots", async () => {
  const f = await fixture();
  const index = new SchedulerJournalIndex();
  const first: SchedulerRun = { ...f.run, status: "pending" };
  const second = { ...first, id: "second", requestId: "second-request" };
  const empty: SchedulerTransaction = {
    version: 1,
    jobs: [],
    runs: [],
    deletedJobs: [],
    deletedRuns: [],
  };
  index.apply({ ...empty, jobs: [f.job], runs: [first, second] }, "active");
  index.apply({ ...empty, runs: [{ ...first, status: "running" }] }, "updated");
  expect((await index.snapshot("active")).runs.map((run) => run.id)).toEqual([
    first.id,
    second.id,
  ]);
  index.apply({ ...empty, runOrder: [second.id, first.id] }, "ordered");
  expect((await index.snapshot("active")).runs.map((run) => run.id)).toEqual([
    second.id,
    first.id,
  ]);
});
