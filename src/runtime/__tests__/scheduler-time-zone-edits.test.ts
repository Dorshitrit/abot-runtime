import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SchedulerExecutor,
  SchedulerScheduleInput,
  SchedulerService,
} from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";

const resources: { service: SchedulerService; directory: string }[] = [];
const instantSchedules: SchedulerScheduleInput[] = [
  { kind: "timer", delayMs: 1_000 },
  { kind: "once", at: "2026-09-05T10:00:01Z" },
  { kind: "interval", everyMs: 1_000 },
];
const calendarSchedules: SchedulerScheduleInput[] = [
  { kind: "daily", at: "10:01" },
  { kind: "weekly", at: "10:01", weekdays: [6] },
  { kind: "monthly", at: "10:01", dayOfMonth: 5 },
];

async function fixture(schedule: SchedulerScheduleInput) {
  const directory = await mkdtemp(join(tmpdir(), "abot-scheduler-zone-"));
  let now = Date.parse("2026-09-05T10:00:00Z");
  let busy = true;
  const start = vi.fn<SchedulerExecutor["start"]>(async () => ({
    status: "succeeded",
  }));
  const service = createSchedulerService({
    environmentId: "test",
    store: createFileSchedulerStore(directory),
    now: () => now,
    tickIntervalMs: 1_000_000,
    executor: {
      sessionExists: async () => true,
      tryReserve: () => (busy ? null : () => undefined),
      start,
    },
  });
  resources.push({ service, directory });
  await service.start();
  const job = await service.create({
    sessionId: "session",
    title: "Scheduled work",
    prompt: "Do the saved work",
    modelProfileId: "model",
    agentMode: "fast",
    timeZone: "UTC",
    schedule,
  });
  return {
    service,
    job,
    start,
    freeSession: () => {
      busy = false;
    },
    advance: (ms: number) => {
      now += ms;
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

describe.each(["schedule", "manual"] as const)(
  "scheduler time-zone edits with a pending %s run",
  (trigger) => {
    it.each(instantSchedules)(
      "preserves the $kind due time and replaces only the pending snapshot",
      async (schedule) => {
        const f = await fixture(schedule);
        if (trigger === "manual") await f.service.runNow(f.job.id);
        if (trigger === "schedule") f.advance(1_000);
        await f.service.tick();
        const before = (await f.service.get(f.job.id))!;
        const [pending] = await f.service.listRuns(f.job.id);

        const edited = await f.service.update(f.job.id, {
          timeZone: "Asia/Tokyo",
        });

        expect(edited).toMatchObject({
          timeZone: "Asia/Tokyo",
          revision: before.revision + 1,
          schedule: before.schedule,
          nextRunAt: before.nextRunAt,
          state: before.state,
        });
        const runs = await f.service.listRuns(f.job.id);
        expect(runs).toHaveLength(2);
        expect(runs[0]).toMatchObject({
          ...pending,
          status: "cancelled",
        });
        expect(runs[1]).toMatchObject({
          status: "pending",
          scheduledAt: pending.scheduledAt,
          trigger,
          timeZone: "Asia/Tokyo",
          jobRevision: edited.revision,
        });
        expect(runs[1].id).not.toBe(pending.id);

        f.freeSession();
        await f.service.tick();
        expect(f.start).toHaveBeenCalledOnce();
        expect(f.start.mock.calls[0][1]).toMatchObject({
          id: runs[1].id,
          timeZone: "Asia/Tokyo",
          scheduledAt: pending.scheduledAt,
          trigger,
        });
      },
    );
  },
);

describe("scheduler time-zone edit validation and calendar timing", () => {
  it.each(calendarSchedules)(
    "reschedules a pending $kind occurrence in the new calendar zone",
    async (schedule) => {
      const f = await fixture(schedule);
      f.advance(60_000);
      await f.service.tick();
      const [pending] = await f.service.listRuns(f.job.id);
      const edited = await f.service.update(f.job.id, {
        timeZone: "America/New_York",
      });
      expect(edited).toMatchObject({
        timeZone: "America/New_York",
        nextRunAt: "2026-09-05T14:01:00.000Z",
        revision: 2,
      });
      expect(await f.service.listRuns(f.job.id)).toEqual([
        expect.objectContaining({ id: pending.id, status: "cancelled" }),
      ]);
      f.freeSession();
      await f.service.tick();
      expect(f.start).not.toHaveBeenCalled();
      f.advance(4 * 60 * 60 * 1_000);
      await f.service.tick();
      expect(f.start).toHaveBeenCalledOnce();
      expect(f.start.mock.calls[0][1]).toMatchObject({
        scheduledAt: edited.nextRunAt,
        timeZone: "America/New_York",
        jobRevision: edited.revision,
      });
    },
  );

  it.each([...instantSchedules, ...calendarSchedules])(
    "rejects invalid zones and preserves $kind pending identity for no-op edits",
    async (schedule) => {
      const f = await fixture(schedule);
      const pending = await f.service.runNow(f.job.id);
      await expect(
        f.service.update(f.job.id, { timeZone: "Invalid/Zone" }),
      ).rejects.toThrow("An IANA timeZone is required");
      expect(await f.service.get(f.job.id)).toEqual(f.job);
      expect(await f.service.update(f.job.id, {})).toEqual(f.job);
      expect(
        await f.service.update(f.job.id, { timeZone: "UTC" }),
      ).toEqual(f.job);
      expect(await f.service.listRuns(f.job.id)).toEqual([pending]);
    },
  );
});
