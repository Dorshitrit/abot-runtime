import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CreateSchedulerJobInput,
  SchedulerExecutor,
  SchedulerRunOutcome,
  SchedulerService,
} from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";
import { parseSchedulerSnapshot } from "../scheduler/snapshot-validation.js";

const directories: string[] = [];
const services: SchedulerService[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "abot-scheduler-"));
  directories.push(directory);
  let now = Date.parse("2026-09-05T10:00:00Z");
  const busy = new Set<string>();
  const exists = vi.fn(async () => true);
  const started = vi.fn<SchedulerExecutor["start"]>(async () => ({
    status: "succeeded",
    resultText: "done",
  }));
  const executor: SchedulerExecutor = {
    sessionExists: exists,
    tryReserve: (sessionId) => {
      if (busy.has(sessionId)) return null;
      busy.add(sessionId);
      return () => {
        busy.delete(sessionId);
      };
    },
    start: started,
  };
  const store = createFileSchedulerStore(directory);
  const service = createSchedulerService({
    environmentId: "dev",
    store,
    executor,
    now: () => now,
    tickIntervalMs: 1_000_000,
  });
  services.push(service);
  await service.start();
  const input: CreateSchedulerJobInput = {
    sessionId: "session-a",
    title: "Reminder",
    prompt: "Do the saved work",
    modelProfileId: "creator-model",
    agentMode: "fast",
    timeZone: "UTC",
    schedule: { kind: "interval", everyMs: 60_000 },
  };
  return {
    service,
    store,
    directory,
    executor,
    input,
    busy,
    exists,
    started,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
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
describe("scheduler service", () => {
  it("records full-access requests, results, and immutable prompt snapshots", async () => {
    const f = await fixture();
    const completion = deferred<SchedulerRunOutcome>();
    f.started.mockReturnValue(completion.promise);
    const job = await f.service.create(f.input);
    f.advance(60_000);
    await f.service.tick();
    expect(f.started).toHaveBeenCalledOnce();
    expect(f.started.mock.calls[0][0].toolPermissionMode).toBe("full_access");
    await f.service.update(job.id, {
      prompt: "Edited future work",
      modelProfileId: "future-model",
      agentMode: "deep",
      timeZone: "Asia/Tokyo",
    });
    completion.resolve({
      status: "succeeded",
      resultText: "original done",
      resultMessageId: "message-1",
    });
    await vi.waitFor(async () =>
      expect((await f.service.listRuns(job.id))[0].status).toBe("succeeded"),
    );
    expect((await f.service.listRuns(job.id))[0]).toMatchObject({
      prompt: "Do the saved work",
      modelProfileId: "creator-model",
      agentMode: "fast",
      timeZone: "UTC",
      jobRevision: 1,
      resultText: "original done",
      resultMessageId: "message-1",
    });
  });
  it("rejects persisted runs with missing historical settings instead of inventing them", async () => {
    const f = await fixture();
    const job = await f.service.create(f.input);
    await f.service.runNow(job.id);
    const snapshot = await f.store.read();
    const damagedRun = snapshot.runs[0] as unknown as Record<string, unknown>;
    delete damagedRun.modelProfileId;
    expect(() => parseSchedulerSnapshot(snapshot)).toThrow(
      "scheduler_store_corrupt",
    );
    expect((await f.service.listRuns(job.id))[0].modelProfileId).toBe(
      "creator-model",
    );
  });
  it("coalesces due times to one pending occurrence while session is busy", async () => {
    const f = await fixture();
    const job = await f.service.create(f.input);
    f.busy.add(f.input.sessionId);
    f.advance(60_000);
    await f.service.tick();
    f.advance(180_000);
    await f.service.tick();
    expect(
      (await f.service.listRuns(job.id)).filter(
        (run) => run.status === "pending",
      ),
    ).toHaveLength(1);
    expect(f.started).not.toHaveBeenCalled();
    f.busy.clear();
    await f.service.tick();
    expect(f.started).toHaveBeenCalledOnce();
  });
  it.each([
    { kind: "daily", at: "10:01" } as const,
    { kind: "interval", everyMs: 60_000 } as const,
    { kind: "timer", delayMs: 60_000 } as const,
  ])(
    "preserves a $kind occurrence behind a pending manual run",
    async (schedule) => {
      const f = await fixture();
      const job = await f.service.create({ ...f.input, schedule });
      f.busy.add(f.input.sessionId);
      const manual = await f.service.runNow(job.id);
      f.advance(60_000);
      await f.service.tick();
      f.advance(180_000);
      await f.service.tick();
      expect(await f.service.get(job.id)).toMatchObject({
        state: "active",
        nextRunAt: job.nextRunAt,
      });
      expect(await f.service.listRuns(job.id)).toEqual([manual]);
      expect(f.started).not.toHaveBeenCalled();

      f.busy.clear();
      await f.service.tick();
      await vi.waitFor(async () =>
        expect((await f.service.listRuns(job.id))[0].status).toBe("succeeded"),
      );
      await f.service.tick();
      await vi.waitFor(async () =>
        expect((await f.service.listRuns(job.id))[1].status).toBe("succeeded"),
      );
      expect(f.started.mock.calls.map(([, run]) => run.trigger)).toEqual([
        "manual",
        "schedule",
      ]);
      expect(f.started.mock.calls[1][1].scheduledAt).toBe(job.nextRunAt);
      const expectedNext = {
        daily: "2026-09-06T10:01:00.000Z",
        interval: "2026-09-05T10:05:00.000Z",
        timer: null,
      }[schedule.kind];
      expect((await f.service.get(job.id))?.nextRunAt).toBe(expectedNext);
      await f.service.tick();
      expect(f.started).toHaveBeenCalledTimes(2);
    },
  );
  it("cancels the due occurrence held behind a pending manual run", async () => {
    const f = await fixture();
    const job = await f.service.create(f.input);
    f.busy.add(f.input.sessionId);
    await f.service.runNow(job.id);
    f.advance(60_000);
    await f.service.tick();
    await f.service.cancel(job.id);
    f.busy.clear();
    await f.service.tick();
    expect(f.started).not.toHaveBeenCalled();
    expect(await f.service.get(job.id)).toMatchObject({
      state: "cancelled",
      nextRunAt: null,
    });
    expect((await f.service.listRuns(job.id)).map((run) => run.status)).toEqual(
      ["cancelled"],
    );
  });
  it("cancels pending dispatch during awaited session lookup before any execution", async () => {
    const f = await fixture();
    const job = await f.service.create(f.input);
    const lookup = deferred<boolean>();
    f.exists.mockReturnValueOnce(lookup.promise);
    f.advance(60_000);
    const ticking = f.service.tick();
    await vi.waitFor(() => expect(f.exists).toHaveBeenCalledTimes(2));
    const cancelling = f.service.cancel(job.id);
    lookup.resolve(true);
    await ticking;
    await cancelling;
    expect(f.started).not.toHaveBeenCalled();
    expect((await f.service.listRuns(job.id))[0].status).toBe("cancelled");
  });
  it("keeps a started run alive on cancellation but never starts another", async () => {
    const f = await fixture();
    const completion = deferred<SchedulerRunOutcome>();
    f.started.mockReturnValue(completion.promise);
    const job = await f.service.create(f.input);
    f.advance(60_000);
    await f.service.tick();
    await f.service.cancel(job.id);
    completion.resolve({ status: "succeeded" });
    await vi.waitFor(async () =>
      expect((await f.service.listRuns(job.id))[0].status).toBe("succeeded"),
    );
    f.advance(120_000);
    await f.service.tick();
    expect(f.started).toHaveBeenCalledOnce();
  });
  it("removes session jobs and runs without recreating them after late completion", async () => {
    const f = await fixture();
    const completion = deferred<SchedulerRunOutcome>();
    f.started.mockReturnValue(completion.promise);
    await f.service.create(f.input);
    f.advance(60_000);
    await f.service.tick();
    await f.service.deleteSession(f.input.sessionId);
    completion.resolve({ status: "succeeded", resultText: "late" });
    await vi.waitFor(() => expect(f.busy.size).toBe(0));
    expect(await f.service.list()).toEqual([]);
    expect(await f.service.listRuns()).toEqual([]);
  });
  it("records failure without retry and uses the next ordinary occurrence", async () => {
    const f = await fixture();
    f.started.mockRejectedValue(new Error("model_unavailable"));
    const job = await f.service.create(f.input);
    f.advance(60_000);
    await f.service.tick();
    await vi.waitFor(async () =>
      expect((await f.service.listRuns(job.id))[0].status).toBe("failed"),
    );
    f.advance(1_000);
    await f.service.tick();
    expect(f.started).toHaveBeenCalledOnce();
    f.advance(59_000);
    await f.service.tick();
    expect(f.started).toHaveBeenCalledTimes(2);
  });
  it("runs manual jobs while paused and resumes future cadence", async () => {
    const f = await fixture();
    const job = await f.service.create(f.input);
    await f.service.pause(job.id);
    f.advance(60_000);
    await f.service.tick();
    expect(f.started).not.toHaveBeenCalled();
    await f.service.runNow(job.id);
    await f.service.tick();
    expect(f.started).toHaveBeenCalledOnce();
    await f.service.resume(job.id);
    expect((await f.service.get(job.id))?.nextRunAt).toBe(
      "2026-09-05T10:02:00.000Z",
    );
  });
  it("cancels a queued manual run when pausing an already-paused Job", async () => {
    const f = await fixture();
    const job = await f.service.create(f.input);
    const paused = await f.service.pause(job.id);
    f.busy.add(f.input.sessionId);
    const pending = await f.service.runNow(job.id);
    await f.service.tick();
    expect(await f.service.pause(job.id)).toEqual(paused);
    expect((await f.service.listRuns(job.id))[0]).toMatchObject({
      id: pending.id,
      status: "cancelled",
      finishedAt: new Date(f.now()).toISOString(),
    });
    f.busy.clear();
    await f.service.tick();
    expect(f.started).not.toHaveBeenCalled();
    expect(await f.service.pause(job.id)).toEqual(paused);
    await f.service.runNow(job.id);
    await f.service.tick();
    expect(f.started).toHaveBeenCalledOnce();
  });
  it("repeated pause cancels pending work while an already-started manual run continues", async () => {
    const f = await fixture();
    const completion = deferred<SchedulerRunOutcome>();
    f.started.mockReturnValue(completion.promise);
    const job = await f.service.create(f.input);
    await f.service.pause(job.id);
    const running = await f.service.runNow(job.id);
    await f.service.tick();
    const pending = await f.service.runNow(job.id);
    await f.service.pause(job.id);
    expect(
      (await f.service.listRuns(job.id)).map(({ id, status }) => ({
        id,
        status,
      })),
    ).toEqual([
      { id: running.id, status: "running" },
      { id: pending.id, status: "cancelled" },
    ]);
    completion.resolve({ status: "succeeded" });
    await vi.waitFor(async () =>
      expect((await f.service.listRuns(job.id))[0].status).toBe("succeeded"),
    );
    await f.service.tick();
    expect(f.started).toHaveBeenCalledOnce();
  });
  it("restarts without catch-up and marks interrupted requests without awaiting them", async () => {
    const f = await fixture();
    const never = deferred<SchedulerRunOutcome>();
    f.started.mockReturnValue(never.promise);
    const job = await f.service.create(f.input);
    f.advance(60_000);
    await f.service.tick();
    await f.service.stop();
    f.advance(180_000);
    const resumed = createSchedulerService({
      environmentId: "dev",
      store: createFileSchedulerStore(f.directory),
      executor: f.executor,
      now: f.now,
      tickIntervalMs: 1_000_000,
    });
    services.push(resumed);
    await resumed.start();
    expect((await resumed.listRuns(job.id)).map((run) => run.status)).toEqual([
      "interrupted",
      "missed",
    ]);
    expect((await resumed.get(job.id))?.nextRunAt).toBe(
      "2026-09-05T10:05:00.000Z",
    );
    await resumed.tick();
    expect(f.started).toHaveBeenCalledOnce();
  });
  it("rejects a second process owner without mutating the first store", async () => {
    const f = await fixture();
    await f.service.create(f.input);
    const second = createSchedulerService({
      environmentId: "dev",
      store: createFileSchedulerStore(f.directory),
      executor: f.executor,
    });
    services.push(second);
    await expect(second.start()).rejects.toThrow("scheduler_store_in_use");
    expect(await f.service.list()).toHaveLength(1);
  });
});
