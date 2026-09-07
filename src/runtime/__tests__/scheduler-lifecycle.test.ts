import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SchedulerExecutor,
  SchedulerRunOutcome,
  SchedulerService,
  SchedulerStore,
} from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";

const directories: string[] = [];
const services: SchedulerService[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
async function prepare(
  storeTransform?: (store: SchedulerStore) => SchedulerStore,
) {
  const directory = await mkdtemp(join(tmpdir(), "abot-scheduler-lifecycle-"));
  directories.push(directory);
  let now = Date.parse("2026-09-05T10:00:00Z");
  const start = vi.fn<SchedulerExecutor["start"]>(async () => ({
    status: "succeeded",
  }));
  const executor: SchedulerExecutor = {
    sessionExists: async () => true,
    tryReserve: () => () => undefined,
    start,
  };
  const base = createFileSchedulerStore(directory);
  const store = storeTransform?.(base) ?? base;
  const service = createSchedulerService({
    environmentId: "test",
    store,
    executor,
    now: () => now,
    tickIntervalMs: 1_000_000,
  });
  services.push(service);
  const create = () =>
    service.create({
      sessionId: "session",
      title: "Test",
      prompt: "Run once",
      modelProfileId: "model",
      agentMode: "fast",
      timeZone: "UTC",
      schedule: { kind: "timer", delayMs: 1_000 },
    });
  return {
    directory,
    service,
    store,
    start,
    create,
    advance: () => {
      now += 1_000;
    },
  };
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("scheduler admission and lifecycle races", () => {
  it("does not start or retain ownership when stop arrives during async startup", async () => {
    const entered = deferred<void>();
    const continueAcquire = deferred<void>();
    const f = await prepare((store) => ({
      ...store,
      acquire: async () => {
        entered.resolve();
        await continueAcquire.promise;
        return store.acquire();
      },
    }));
    const starting = f.service.start();
    await entered.promise;
    const stopping = f.service.stop();
    continueAcquire.resolve();
    await starting;
    await stopping;
    await expect(f.service.list()).rejects.toThrow("scheduler_not_started");
    const otherOwner = createFileSchedulerStore(f.directory);
    const release = await otherOwner.acquire();
    await release();
  });
  it("prevents execution when cancellation arrives after persisted claim but before dispatch", async () => {
    const claimed = deferred<void>();
    const continueClaim = deferred<void>();
    const f = await prepare((store) => ({
      ...store,
      update: async (mutate) => {
        const result = await store.update(mutate);
        const candidate = result as unknown as {
          run?: { status?: string };
        } | null;
        if (candidate?.run?.status === "running") {
          claimed.resolve();
          await continueClaim.promise;
        }
        return result;
      },
    }));
    await f.service.start();
    const job = await f.create();
    f.advance();
    const ticking = f.service.tick();
    await claimed.promise;
    const cancelled = f.service.cancel(job.id);
    continueClaim.resolve();
    await ticking;
    await cancelled;
    expect(f.start).not.toHaveBeenCalled();
    expect((await f.service.listRuns(job.id))[0].status).toBe("cancelled");
  });
  it("honors cancellation intent while tick is still persisting the due occurrence", async () => {
    const entered = deferred<void>();
    const continueWrite = deferred<void>();
    let holdNextWrite = false;
    const f = await prepare((store) => ({
      ...store,
      update: async (mutate) => {
        const result = await store.update(mutate);
        if (!holdNextWrite) return result;
        holdNextWrite = false;
        entered.resolve();
        await continueWrite.promise;
        return result;
      },
    }));
    await f.service.start();
    const job = await f.create();
    holdNextWrite = true;
    f.advance();
    const ticking = f.service.tick();
    await entered.promise;
    const cancelling = f.service.cancel(job.id);
    continueWrite.resolve();
    await ticking;
    await cancelling;
    expect(f.start).not.toHaveBeenCalled();
    expect((await f.service.listRuns(job.id))[0].status).toBe("cancelled");
  });
  it("ignores the previous generation's eventual completion after restarting the same service", async () => {
    const f = await prepare();
    const oldCompletion = deferred<SchedulerRunOutcome>();
    f.start.mockReturnValueOnce(oldCompletion.promise);
    await f.service.start();
    const job = await f.create();
    f.advance();
    await f.service.tick();
    await f.service.stop();
    await f.service.start();
    oldCompletion.resolve({ status: "succeeded", resultText: "obsolete" });
    await new Promise((resolve) => setImmediate(resolve));
    const [run] = await f.service.listRuns(job.id);
    expect(run.status).toBe("interrupted");
    expect(run.resultText).toBeUndefined();
  });
  it("serializes simultaneous creations without lost writes", async () => {
    const f = await prepare();
    await f.service.start();
    const jobs = await Promise.all(Array.from({ length: 8 }, () => f.create()));
    expect(new Set(jobs.map((job) => job.id)).size).toBe(8);
    expect(await f.service.list()).toHaveLength(8);
  });
});
