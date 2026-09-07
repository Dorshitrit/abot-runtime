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

const interception = vi.hoisted(() => ({
  path: "",
  entered: () => {},
  waiting: Promise.resolve(),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === interception.path) {
        interception.path = "";
        interception.entered();
        await interception.waiting;
      }
      return actual.readFile(...args);
    }),
  };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  interception.path = "";
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
});
function holdRead(path: string) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  interception.path = path;
  interception.entered = enter;
  interception.waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanups.push(async () => release());
  return { entered, release };
}
async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), "scheduler-journal-read-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const jobs: SchedulerJob[] = ["deleted", "retained"].map((id) => ({
    id,
    sessionId: id,
    environmentId: "test",
    title: id,
    prompt: id,
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
  const runs = jobs.map((job) => ({
    ...makeSchedulerRun(job, "2026-09-06T09:00:00.000Z", "manual"),
    status: "succeeded" as const,
    resultText: job.id,
  }));
  const snapshot: SchedulerSnapshot = { schemaVersion: 1, jobs, runs };
  await fs.writeFile(
    join(directory, "scheduler.json"),
    JSON.stringify(snapshot),
  );
  return { directory, snapshot };
}
async function own(directory: string) {
  const store = createFileSchedulerStore(directory);
  const release = await store.acquire();
  cleanups.push(release);
  return store;
}
async function historyPath(directory: string) {
  const manifest = JSON.parse(
    await fs.readFile(join(directory, "scheduler-journal.json"), "utf8"),
  );
  return join(directory, manifest.generation, "0000000000000002.json");
}
function removeSession(store: SchedulerStore, entered?: () => void) {
  return store.update((state) => {
    entered?.();
    state.jobs = state.jobs.filter((job) => job.id !== "deleted");
    state.runs = state.runs.filter((run) => run.jobId !== "deleted");
  }, "active");
}

test.each(["read", "readRuns"])(
  "owned %s finishes its selected generation before deletion retires it",
  async (method) => {
    const f = await fixture();
    const store = await own(f.directory);
    const gate = holdRead(await historyPath(f.directory));
    const order: string[] = [];
    const reading = method === "read" ? store.read() : store.readRuns!();
    const observed = reading
      .then((result) => {
        order.push("read");
        return result;
      })
      .catch((error: unknown) => error);
    await gate.entered;
    const deleting = removeSession(store, () => {
      order.push("mutation");
    });
    // A broken writer can retire the file; a serialized writer needs the reader
    // released first. The deadline only releases the test gate, never asserts timing.
    const releaseDeadline = setTimeout(gate.release, 1000);
    void deleting.then(gate.release, gate.release);
    try {
      expect(await observed).toEqual(
        method === "read" ? f.snapshot : f.snapshot.runs,
      );
      await deleting;
      expect(order).toEqual(["read", "mutation"]);
      expect((await store.read()).jobs.map((job) => job.id)).toEqual([
        "retained",
      ]);
    } finally {
      clearTimeout(releaseDeadline);
      gate.release();
      await deleting;
    }
  },
);

test("unowned reader restarts a snapshot when the selected generation is retired", async () => {
  const f = await fixture();
  const owner = await own(f.directory);
  const gate = holdRead(await historyPath(f.directory));
  const reading = createFileSchedulerStore(f.directory).read();
  const observed = reading.catch((error: unknown) => error);
  await gate.entered;
  await removeSession(owner);
  gate.release();
  expect(await observed).toEqual({
    schemaVersion: 1,
    jobs: [f.snapshot.jobs[1]],
    runs: [f.snapshot.runs[1]],
  });
});

test("unowned legacy reader follows a completed journal migration instead of returning an empty snapshot", async () => {
  const f = await fixture();
  const gate = holdRead(join(f.directory, "scheduler.json"));
  const reading = createFileSchedulerStore(f.directory).read();
  const observed = reading.catch((error: unknown) => error);
  await gate.entered;
  const owner = await own(f.directory);
  await removeSession(owner);
  gate.release();
  expect(await observed).toEqual({
    schemaVersion: 1,
    jobs: [f.snapshot.jobs[1]],
    runs: [f.snapshot.runs[1]],
  });
});
