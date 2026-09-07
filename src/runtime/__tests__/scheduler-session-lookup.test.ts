import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  SchedulerExecutor,
  SchedulerService,
} from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";

const directories: string[] = [];
const services: SchedulerService[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "abot-scheduler-lookup-"));
  directories.push(directory);
  let now = Date.parse("2026-09-06T10:00:00Z");
  const sessionExists = vi.fn(async (_sessionId: string) => true);
  const start = vi.fn<SchedulerExecutor["start"]>(async () => ({
    status: "succeeded",
  }));
  const tryReserve = vi.fn(() => () => undefined);
  const onError = vi.fn();
  const service = createSchedulerService({
    environmentId: "test",
    store: createFileSchedulerStore(directory),
    executor: { sessionExists, start, tryReserve },
    now: () => now,
    tickIntervalMs: 1_000_000,
    onError,
  });
  services.push(service);
  await service.start();
  const create = (sessionId: string) =>
    service.create({
      sessionId,
      title: "Session lookup test",
      prompt: "Saved work",
      modelProfileId: "test",
      agentMode: "fast",
      timeZone: "UTC",
      schedule: { kind: "interval", everyMs: 60_000 },
    });
  return {
    service,
    sessionExists,
    start,
    tryReserve,
    onError,
    create,
    advance: () => {
      now += 60_000;
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

it("records a lookup failure without retry and still dispatches healthy pending runs", async () => {
  const f = await fixture();
  const broken = await f.create("broken");
  const healthy = await f.create("healthy");
  const failure = new Error("invalid session JSON");
  f.sessionExists.mockImplementation(async (sessionId) => {
    if (sessionId === "broken") throw failure;
    return true;
  });
  f.advance();
  await f.service.tick();
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.start.mock.calls[0][0].id).toBe(healthy.id);
  expect(f.tryReserve).toHaveBeenCalledExactlyOnceWith("healthy");
  expect((await f.service.listRuns(broken.id))[0]).toMatchObject({
    status: "failed",
    error: "scheduler_session_lookup_failed: invalid session JSON",
    finishedAt: "2026-09-06T10:01:00.000Z",
  });
  expect((await f.service.listRuns(broken.id))[0].startedAt).toBeUndefined();
  expect(f.onError).toHaveBeenCalledOnce();
  expect(f.onError.mock.calls[0][0].cause).toBe(failure);
  const lookupCount = f.sessionExists.mock.calls.length;
  await f.service.tick();
  expect(f.sessionExists).toHaveBeenCalledTimes(lookupCount);
  f.sessionExists.mockResolvedValue(true);
  f.advance();
  await f.service.tick();
  expect(f.start.mock.calls.some(([job]) => job.id === broken.id)).toBe(true);
});

it("keeps a cancellation authoritative when an in-flight lookup fails", async () => {
  const f = await fixture();
  const job = await f.create("session");
  let rejectLookup!: (reason: Error) => void;
  f.sessionExists.mockImplementationOnce(
    () =>
      new Promise<boolean>((_resolve, reject) => {
        rejectLookup = reject;
      }),
  );
  f.advance();
  const ticking = f.service.tick();
  await vi.waitFor(() => expect(rejectLookup).toBeTypeOf("function"));
  const cancelling = f.service.cancel(job.id);
  rejectLookup(new Error("session unreadable"));
  await ticking;
  await cancelling;
  expect((await f.service.listRuns(job.id))[0].status).toBe("cancelled");
  expect(f.start).not.toHaveBeenCalled();
  expect(f.tryReserve).not.toHaveBeenCalled();
});

it("still removes deleted sessions and dispatches the remaining snapshot", async () => {
  const f = await fixture();
  const removed = await f.create("removed");
  await f.create("healthy");
  f.sessionExists.mockImplementation(
    async (sessionId) => sessionId !== "removed",
  );
  f.advance();
  await f.service.tick();
  expect(await f.service.get(removed.id)).toBeNull();
  expect(await f.service.listRuns(removed.id)).toEqual([]);
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.onError).not.toHaveBeenCalled();
});

it.each([{}, { title: "Session lookup test" }, { timeZone: "Invalid/Zone" }])(
  "does not retry a failed lookup when a concurrent edit preserves the pending run: %j",
  async (patch) => {
    const f = await fixture();
    const job = await f.create("session");
    let rejectLookup!: (reason: Error) => void;
    f.sessionExists.mockImplementationOnce(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectLookup = reject;
        }),
    );
    f.advance();
    const ticking = f.service.tick();
    await vi.waitFor(() => expect(rejectLookup).toBeTypeOf("function"));
    const editing = f.service.update(job.id, patch).catch(() => undefined);
    rejectLookup(new Error("unreadable"));
    await ticking;
    await editing;
    expect((await f.service.listRuns(job.id))[0].status).toBe("failed");
    const lookups = f.sessionExists.mock.calls.length;
    await f.service.tick();
    expect(f.sessionExists).toHaveBeenCalledTimes(lookups);
    expect(f.start).not.toHaveBeenCalled();
  },
);
