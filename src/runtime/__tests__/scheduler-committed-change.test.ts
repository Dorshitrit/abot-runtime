import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";
import type {
  SchedulerJob,
  SchedulerSnapshot,
} from "../scheduler/contracts.js";

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

function job(): SchedulerJob {
  return {
    id: "job",
    sessionId: "session",
    environmentId: "test",
    title: "Original",
    prompt: "Saved work",
    modelProfileId: "model",
    agentMode: "fast",
    toolPermissionMode: "full_access",
    timeZone: "UTC",
    state: "active",
    schedule: { kind: "daily", at: "09:00" },
    revision: 1,
    createdAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2099-01-01T00:00:00.000Z",
    nextRunAt: "2099-01-02T09:00:00.000Z",
  };
}

async function fixture(notify: () => void) {
  const directory = await fs.mkdtemp(
    join(tmpdir(), "scheduler-committed-change-"),
  );
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const snapshot: SchedulerSnapshot = {
    schemaVersion: 1,
    jobs: [job()],
    runs: [],
  };
  await fs.writeFile(
    join(directory, "scheduler.json"),
    JSON.stringify(snapshot),
  );
  const store = createFileSchedulerStore(directory, notify);
  return { directory, store, reader: createFileSchedulerStore(directory) };
}

test("listeners see durable changed state, while migration, reads and no-op updates stay silent", async () => {
  const observations: Promise<SchedulerSnapshot>[] = [];
  const notify = vi.fn(() => observations.push(f.reader.read()));
  const f = await fixture(notify);
  cleanups.push(await f.store.acquire());
  await f.store.read();
  await f.store.readRuns!();
  await f.store.update(() => undefined);
  expect(notify).not.toHaveBeenCalled();
  await f.store.update((state) => {
    state.jobs[0].title = "Committed";
  });
  expect(notify).toHaveBeenCalledOnce();
  expect((await observations[0]).jobs[0].title).toBe("Committed");
  await f.store.update((state) => {
    state.jobs = [];
  });
  expect(notify).toHaveBeenCalledTimes(2);
  expect((await observations[1]).jobs).toEqual([]);
});

test("a failed write cannot announce a commit and a throwing view cannot fail a successful write", async () => {
  const notify = vi.fn(() => {
    throw new Error("view_failed");
  });
  const f = await fixture(notify);
  cleanups.push(await f.store.acquire());
  faults.manifest = true;
  await expect(
    f.store.update((state) => {
      state.jobs[0].title = "Uncommitted";
    }),
  ).rejects.toThrow("manifest_publication_failed");
  expect(notify).not.toHaveBeenCalled();
  expect((await f.reader.read()).jobs[0].title).toBe("Original");
  faults.manifest = false;
  await expect(
    f.store.update((state) => {
      state.jobs[0].title = "Accepted";
    }),
  ).resolves.toBeUndefined();
  expect(notify).toHaveBeenCalledOnce();
  expect((await f.reader.read()).jobs[0].title).toBe("Accepted");
});

test("a committed removal notifies even if later physical cleanup fails, preserving that failure", async () => {
  const notify = vi.fn();
  const f = await fixture(notify);
  cleanups.push(await f.store.acquire());
  const head = JSON.parse(
    await fs.readFile(join(f.directory, "scheduler-journal.json"), "utf8"),
  );
  faults.removal = join(f.directory, head.generation);
  await expect(
    f.store.update((state) => {
      state.jobs = [];
    }),
  ).rejects.toThrow("generation_cleanup_failed");
  expect(notify).toHaveBeenCalledOnce();
  expect((await f.reader.read()).jobs).toEqual([]);
});

test("an idle scheduler tick emits nothing, while a committed management change emits once", async () => {
  const notify = vi.fn();
  const f = await fixture(notify);
  const service = createSchedulerService({
    environmentId: "test",
    store: f.store,
    now: () => Date.parse("2099-01-01T00:00:00Z"),
    tickIntervalMs: 60_000,
    executor: {
      sessionExists: async () => true,
      tryReserve: () => null,
      start: async () => ({ status: "succeeded" }),
    },
  });
  await service.start();
  cleanups.push(service.stop);
  expect(notify).not.toHaveBeenCalled();
  await service.tick();
  await service.list();
  await service.listRuns();
  expect(notify).not.toHaveBeenCalled();
  await service.pause("job");
  expect(notify).toHaveBeenCalledOnce();
  await service.pause("job");
  await service.tick();
  expect(notify).toHaveBeenCalledOnce();
});
