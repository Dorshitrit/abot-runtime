import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type {
  SchedulerAutomationExecutor,
  SchedulerAutomationScheduleInput,
} from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function activationFixture(schedule: SchedulerAutomationScheduleInput) {
  const directory = await mkdtemp(join(tmpdir(), "automation-activation-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = createFileSchedulerStore(directory);
  let now = Date.parse("2026-09-29T08:00:00.000Z");
  const prepare = vi.fn<SchedulerAutomationExecutor["prepare"]>();
  const start = vi.fn<SchedulerAutomationExecutor["start"]>();
  const service = createSchedulerService({
    environmentId: "dev", store, now: () => now, tickIntervalMs: 1_000_000,
    executor: {
      sessionExists: async () => true, tryReserve: () => null, start: vi.fn(),
    },
    automationExecutor: {
      prepare, start, tryReserve: () => null, stop: vi.fn(),
      cancelPending: vi.fn(), settle: vi.fn(), recover: vi.fn(),
    },
  });
  cleanups.push(() => service.stop());
  await service.start();
  const job = await service.createAutomationJob({
    automationId: "automation-1", definitionRevision: 1,
    title: "Activation timing", timeZone: "UTC", schedule,
  });
  return {
    service, store, job, prepare, start,
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

const singleOccurrences: SchedulerAutomationScheduleInput[] = [
  { kind: "once", at: "2026-09-29T08:01:00.000Z" },
  { kind: "timer", delayMs: 60_000 },
];

test.each(singleOccurrences)("activating an expired $kind completes it without dispatch", async (schedule) => {
  const f = await activationFixture(schedule);
  f.advance(120_000);
  const activated = await f.service.resumeAutomationJob(f.job.id);
  expect(activated).toMatchObject({ state: "completed", nextRunAt: null, revision: 2 });
  expect((await f.store.read()).jobs[0]).toEqual(activated);
  await f.service.tick();
  expect((await f.store.read()).runs).toEqual([]);
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

test.each(singleOccurrences)("activating $kind at its deadline does not backfill", async (schedule) => {
  const f = await activationFixture(schedule);
  f.advance(60_000);
  expect(await f.service.resumeAutomationJob(f.job.id))
    .toMatchObject({ state: "completed", nextRunAt: null });
});

test.each(singleOccurrences)("activating a future $kind preserves its deadline", async (schedule) => {
  const f = await activationFixture(schedule);
  f.advance(30_000);
  expect(await f.service.resumeAutomationJob(f.job.id))
    .toMatchObject({ state: "active", nextRunAt: f.job.nextRunAt });
});

test("manual activation stays active without a scheduled occurrence", async () => {
  const f = await activationFixture({ kind: "manual" });
  f.advance(120_000);
  const activated = await f.service.resumeAutomationJob(f.job.id);
  expect(activated).toMatchObject({ state: "active", nextRunAt: null });
  expect((await f.store.read()).jobs[0]).toEqual(activated);
  await f.service.tick();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

test("recurring activation advances to its next future occurrence", async () => {
  const f = await activationFixture({ kind: "interval", everyMs: 60_000 });
  f.advance(120_000);
  expect(await f.service.resumeAutomationJob(f.job.id)).toMatchObject({
    state: "active", nextRunAt: "2026-09-29T08:03:00.000Z",
  });
});
