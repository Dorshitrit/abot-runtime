import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type {
  SchedulerExecutor,
  SchedulerStore,
} from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "scheduler-delete-lifecycle-"),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse("2026-09-06T09:00:00Z");
  const hooks = {
    failAcquire: false,
    failWrite: false,
    afterWrite: undefined as (() => void) | undefined,
  };
  const base = createFileSchedulerStore(directory);
  const store: SchedulerStore = {
    ...base,
    acquire: async () => {
      if (hooks.failAcquire) {
        hooks.failAcquire = false;
        throw new Error("startup_failed");
      }
      return base.acquire();
    },
    update: async (mutate, view) => {
      if (hooks.failWrite) {
        hooks.failWrite = false;
        throw new Error("deletion_write_failed");
      }
      const result = await base.update(mutate, view);
      const afterWrite = hooks.afterWrite;
      hooks.afterWrite = undefined;
      afterWrite?.();
      return result;
    },
  };
  const start = vi.fn<SchedulerExecutor["start"]>(async () => ({
    status: "succeeded",
  }));
  const createService = () => {
    const service = createSchedulerService({
      environmentId: "test",
      store,
      now: () => now,
      tickIntervalMs: 1_000_000,
      executor: {
        sessionExists: async () => true,
        tryReserve: () => () => {},
        start,
      },
    });
    cleanups.push(() => service.stop());
    return service;
  };
  const service = createService();
  await service.start();
  const job = await service.create({
    sessionId: "session",
    title: "Preserved work",
    prompt: "Do work",
    modelProfileId: "model",
    agentMode: "fast",
    timeZone: "UTC",
    schedule: { kind: "interval", everyMs: 1000 },
  });
  await service.stop();
  return {
    service,
    createService,
    job,
    hooks,
    start,
    advance: () => {
      now += 1000;
    },
  };
}

test.each(["before first start", "after stop"])(
  "a rejected delete %s cannot poison a valid persisted session",
  async (phase) => {
    const f = await fixture();
    const service =
      phase === "before first start" ? f.createService() : f.service;
    await expect(service.deleteSession("session")).rejects.toThrow(
      "scheduler_not_started",
    );
    await service.start();
    await expect(service.runNow(f.job.id)).resolves.toMatchObject({
      status: "pending",
    });
    await service.tick();
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
  },
);

test("a deletion rejected behind failed startup leaves the persisted session usable", async () => {
  const f = await fixture();
  f.hooks.failAcquire = true;
  const starting = f.service.start();
  const deleting = f.service.deleteSession("session");
  await expect(starting).rejects.toThrow("startup_failed");
  await expect(deleting).rejects.toThrow("scheduler_not_started");
  await f.service.start();
  await expect(f.service.runNow(f.job.id)).resolves.toMatchObject({
    status: "pending",
  });
});

test.each([false, true])(
  "start-queued intent blocks an earlier queued tick even with a rejected overlapping delete (%s)",
  async (overlap) => {
    const f = await fixture();
    const rejected = overlap
      ? f.service.deleteSession("session").catch((error: unknown) => error)
      : undefined;
    f.hooks.afterWrite = f.advance;
    const starting = f.service.start();
    const ticking = f.service.tick();
    const deleting = f.service.deleteSession("session");
    await Promise.all([starting, ticking, deleting]);
    if (rejected)
      expect(await rejected).toMatchObject({
        message: "scheduler_not_started",
      });
    expect(f.start).not.toHaveBeenCalled();
    expect(await f.service.get(f.job.id)).toBeNull();
    expect(await f.service.listRuns(f.job.id)).toEqual([]);
  },
);

test("a lifecycle-admitted deletion remains confirmed after a storage failure and restart", async () => {
  const f = await fixture();
  await f.service.start();
  f.hooks.failWrite = true;
  await expect(f.service.deleteSession("session")).rejects.toThrow(
    "deletion_write_failed",
  );
  expect(await f.service.get(f.job.id)).not.toBeNull();
  await f.service.stop();
  await f.service.start();
  await expect(f.service.runNow(f.job.id)).rejects.toThrow(
    "scheduler_session_deleted",
  );
  await f.service.deleteSession("session");
  expect(await f.service.get(f.job.id)).toBeNull();
  expect(f.start).not.toHaveBeenCalled();
});
