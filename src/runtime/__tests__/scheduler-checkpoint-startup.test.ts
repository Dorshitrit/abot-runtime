import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SchedulerJob } from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { makeSchedulerRun } from "../scheduler/run-records.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
  };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("reopening replays only a bounded committed suffix without enumerating or reading retained history", async () => {
  const directory = await fs.mkdtemp(
    join(tmpdir(), "scheduler-checkpoint-startup-"),
  );
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createFileSchedulerStore(directory);
  const release = await store.acquire();
  cleanups.push(release);
  const job: SchedulerJob = {
    id: "job",
    sessionId: "session",
    environmentId: "test",
    title: "Original",
    prompt: "Current prompt",
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
  };
  const history = Array.from({ length: 10 }, (_, index) => ({
    ...makeSchedulerRun(
      job,
      new Date(Date.parse(job.createdAt) + index * 1000).toISOString(),
      "schedule",
    ),
    status: "succeeded" as const,
    prompt: `historical prompt ${index}:` + "p".repeat(8192),
    resultText: `historical result ${index}:` + "r".repeat(8192),
  }));
  await store.update((state) => {
    state.jobs.push(job);
    state.runs.push(...history);
  });
  for (let revision = 2; revision <= 520; revision++) {
    await store.update((state) => {
      state.jobs[0].revision = revision;
      state.jobs[0].title = `Revision ${revision}`;
    }, "active");
  }
  await release();
  const manifest = JSON.parse(
    await fs.readFile(join(directory, "scheduler-journal.json"), "utf8"),
  );
  const generation = join(directory, manifest.generation);
  const reads = vi.mocked(fs.readFile).mockClear();
  const listings = vi.mocked(fs.readdir).mockClear();
  const reopened = createFileSchedulerStore(directory);
  const releaseReopened = await reopened.acquire();
  cleanups.push(releaseReopened);
  expect((await reopened.read("active")).jobs[0].title).toBe("Revision 520");
  const transactionReads = reads.mock.calls
    .map(([path]) => String(path))
    .filter((path) => /[0-9]{16}\.json$/.test(path));
  expect(transactionReads.length).toBeLessThanOrEqual(256);
  expect(listings.mock.calls.map(([path]) => String(path))).not.toContain(
    generation,
  );
  expect(transactionReads).not.toContain(
    join(generation, "0000000000000002.json"),
  );
  expect((await reopened.read()).runs).toEqual(history);
  const checkpoints = await fs.readdir(join(generation, "checkpoints"));
  expect(checkpoints).toHaveLength(1);
  const checkpoint = await fs.readFile(
    join(generation, "checkpoints", checkpoints[0]),
    "utf8",
  );
  expect(checkpoint).not.toContain("historical result");
  expect(checkpoint).not.toContain("historical prompt");
}, 20_000);
