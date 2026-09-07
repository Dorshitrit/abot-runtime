import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CreateSchedulerJobInput,
  SchedulerExecutor,
  SchedulerService,
} from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { schedulerInstantFromMilliseconds } from "../scheduler/instant-validation.js";
import { nextSchedulerOccurrence } from "../scheduler/next-occurrence.js";
import { normalizeSchedulerSchedule } from "../scheduler/schedule-validation.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";

const resources: { service: SchedulerService; directory: string }[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-interval-range-"));
  let now = Date.parse("2026-09-06T10:00:00Z");
  const start = vi.fn<SchedulerExecutor["start"]>(async () => ({
    status: "succeeded",
  }));
  const store = createFileSchedulerStore(directory);
  const service = createSchedulerService({
    environmentId: "test",
    store,
    now: () => now,
    tickIntervalMs: 1_000_000,
    executor: {
      sessionExists: async () => true,
      tryReserve: () => () => undefined,
      start,
    },
  });
  resources.push({ service, directory });
  await service.start();
  const input: CreateSchedulerJobInput = {
    sessionId: "session",
    title: "Interval",
    prompt: "Saved work",
    modelProfileId: "model",
    agentMode: "fast",
    timeZone: "UTC",
    schedule: { kind: "interval", everyMs: 60_000 },
  };
  return {
    service,
    store,
    input,
    start,
    advance: () => {
      now += 60_000;
    },
  };
}
afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ service, directory }) => {
      await service.stop();
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("interval admission and canonical instant range", () => {
  it("rejects a new interval whose second occurrence cannot be represented", async () => {
    const f = await fixture();
    await expect(
      f.service.create({
        ...f.input,
        schedule: {
          kind: "interval",
          everyMs: Number.MAX_SAFE_INTEGER,
          anchorAt: "2026-09-06T10:01:00Z",
        },
      }),
    ).rejects.toThrow("supported date range");
    expect(await f.service.list()).toEqual([]);
  });

  it("rejects an unrepresentable reschedule without changing the existing Job or pending run", async () => {
    const f = await fixture();
    const job = await f.service.create(f.input);
    const pending = await f.service.runNow(job.id);
    await expect(
      f.service.update(job.id, {
        schedule: {
          kind: "interval",
          everyMs: Number.MAX_SAFE_INTEGER,
          anchorAt: "2026-09-06T10:01:00Z",
        },
      }),
    ).rejects.toThrow("supported date range");
    expect(await f.service.get(job.id)).toEqual(job);
    expect(await f.service.listRuns(job.id)).toEqual([pending]);
  });

  it("keeps long durations valid when both upcoming occurrences fit the canonical range", async () => {
    const f = await fixture();
    const everyMs = 10 * 365 * 24 * 60 * 60 * 1_000;
    const job = await f.service.create({
      ...f.input,
      schedule: { kind: "interval", everyMs },
    });
    expect(job.schedule).toMatchObject({ everyMs });
    expect(Date.parse(job.nextRunAt!)).toBe(
      Date.parse(job.createdAt) + everyMs,
    );
  });

  it.each(["timer", "interval"] as const)(
    "rejects a generated %s anchor that cannot round-trip the stored ISO format",
    (kind) => {
      const duration = Date.parse("+010000-01-01T00:00:00Z");
      const input =
        kind === "timer"
          ? { kind, delayMs: duration }
          : { kind, everyMs: duration };
      expect(() => normalizeSchedulerSchedule(input, 0)).toThrow(
        "supported date range",
      );
    },
  );

  it("accepts canonical endpoints and rejects extended-year output", () => {
    for (const instant of [
      "0000-01-01T00:00:00.000Z",
      "9999-12-31T23:59:59.999Z",
    ])
      expect(schedulerInstantFromMilliseconds(Date.parse(instant))).toBe(
        instant,
      );
    for (const instant of [
      "-000001-12-31T23:59:59.999Z",
      "+010000-01-01T00:00:00.000Z",
    ])
      expect(() =>
        schedulerInstantFromMilliseconds(Date.parse(instant)),
      ).toThrow("supported date range");
  });

  it("ends interval and calendar recurrence at the canonical range boundary", () => {
    const after = Date.parse("9999-12-31T23:59:59.000Z");
    expect(
      nextSchedulerOccurrence(
        {
          kind: "interval",
          everyMs: 1_000,
          anchorAt: "9999-12-31T23:59:59.000Z",
        },
        "UTC",
        after,
      ),
    ).toBeNull();
    expect(
      nextSchedulerOccurrence({ kind: "daily", at: "09:00" }, "UTC", after),
    ).toBeNull();
  });
});

describe("legacy interval exhaustion isolation", () => {
  async function legacyFixture() {
    const f = await fixture();
    const legacy = await f.service.create({ ...f.input, sessionId: "legacy" });
    const healthy = await f.service.create({
      ...f.input,
      sessionId: "healthy",
    });
    await f.store.update((state) => {
      const job = state.jobs.find((item) => item.id === legacy.id)!;
      job.schedule = {
        kind: "interval",
        everyMs: Number.MAX_SAFE_INTEGER,
        anchorAt: legacy.nextRunAt!,
      };
    });
    return { ...f, legacy, healthy };
  }

  it("runs the final representable legacy occurrence without blocking another due Job", async () => {
    const f = await legacyFixture();
    f.advance();
    await f.service.tick();
    await vi.waitFor(async () =>
      expect((await f.service.listRuns()).map((run) => run.status)).toEqual([
        "succeeded",
        "succeeded",
      ]),
    );
    expect(await f.service.get(f.legacy.id)).toMatchObject({
      state: "completed",
      nextRunAt: null,
    });
    expect(await f.service.get(f.healthy.id)).toMatchObject({
      state: "active",
      nextRunAt: "2026-09-06T10:02:00.000Z",
    });
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it("recovers an exhausted legacy interval after downtime and starts healthy future work", async () => {
    const f = await legacyFixture();
    await f.service.stop();
    f.advance();
    await f.service.start();
    expect(await f.service.get(f.legacy.id)).toMatchObject({
      state: "completed",
      nextRunAt: null,
    });
    expect((await f.service.listRuns(f.legacy.id))[0].status).toBe("missed");
    f.advance();
    await f.service.tick();
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.start.mock.calls[0][0].id).toBe(f.healthy.id);
  });
});
