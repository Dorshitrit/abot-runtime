import { mkdtemp, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ScheduleManagementRoutes } from "../../web-ui/local-runtime/schedule-management-routes.js";
import type { RuntimeConfig } from "../ports.js";
import type {
  CreateSchedulerJobInput,
  SchedulerService,
} from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";

const directories: string[] = [];
const services: SchedulerService[] = [];
const input: CreateSchedulerJobInput = {
  sessionId: "session",
  title: "Timer",
  prompt: "Saved work",
  modelProfileId: "model",
  agentMode: "fast",
  timeZone: "UTC",
  schedule: { kind: "timer", delayMs: 60_000 },
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-timer-"));
  directories.push(directory);
  let now = Date.parse("2026-09-06T10:00:00.123Z");
  const options = {
    environmentId: "test",
    now: () => now,
    tickIntervalMs: 1_000_000,
    executor: {
      sessionExists: async () => true,
      tryReserve: () => null,
      start: async () => ({ status: "succeeded" as const }),
    },
  };
  const store = createFileSchedulerStore(directory);
  const service = createSchedulerService({ ...options, store });
  services.push(service);
  await service.start();
  return {
    service,
    store,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    async restart() {
      await service.stop();
      const restarted = createSchedulerService({
        ...options,
        store: createFileSchedulerStore(directory),
      });
      services.push(restarted);
      await restarted.start();
      return restarted;
    },
    readFresh: () => createFileSchedulerStore(directory).read(),
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

test.each(["2026-09-06T10:00:01Z", "2099-01-01T00:00:00Z", "invalid"])(
  "new timers derive their deadline from delay even when supplied at is %s",
  async (at) => {
    const f = await fixture();
    const schedule = { kind: "timer" as const, delayMs: 60_001, at };
    const job = await f.service.create({ ...input, schedule });
    const deadline = new Date(f.now() + schedule.delayMs).toISOString();
    expect(job.schedule).toEqual({ ...schedule, at: deadline });
    expect(job.nextRunAt).toBe(deadline);
  },
);

test.each([60_000, 90_000])(
  "an actual timer PATCH uses the current clock plus %i milliseconds",
  async (delayMs) => {
    const f = await fixture();
    const job = await f.service.create(input);
    const pending = await f.service.runNow(job.id);
    f.advance(10_000);
    const schedule = {
      kind: "timer" as const,
      delayMs,
      at: "2099-01-01T00:00:00Z",
    };
    const updated = await f.service.update(job.id, { schedule });
    const deadline = new Date(f.now() + delayMs).toISOString();
    expect(updated.schedule).toEqual({ ...schedule, at: deadline });
    expect(updated.nextRunAt).toBe(deadline);
    expect((await f.service.listRuns(job.id))[0]).toMatchObject({
      id: pending.id,
      status: "cancelled",
    });
  },
);

test.each(["create", "update"] as const)(
  "%s cannot bypass timer overflow with a representable supplied at",
  async (action) => {
    const f = await fixture();
    const job = await f.service.create(input);
    const pending = await f.service.runNow(job.id);
    const schedule = {
      kind: "timer" as const,
      delayMs: Number.MAX_SAFE_INTEGER,
      at: job.nextRunAt!,
    };
    const operation =
      action === "create"
        ? f.service.create({ ...input, schedule })
        : f.service.update(job.id, { schedule });
    await expect(operation).rejects.toThrow("supported date range");
    expect(await f.service.list()).toEqual([job]);
    expect(await f.service.listRuns(job.id)).toEqual([pending]);
  },
);

test("metadata edits and exact canonical timer no-ops preserve the saved deadline and pending identity", async () => {
  const f = await fixture();
  const job = await f.service.create(input);
  f.advance(60_000);
  await f.service.tick();
  const [pending] = await f.service.listRuns(job.id);
  const before = await f.service.get(job.id);
  expect(await f.service.update(job.id, {})).toEqual(before);
  const exactSchedule = {
    at: job.nextRunAt!,
    delayMs: 60_000,
    kind: "timer" as const,
  };
  expect(await f.service.update(job.id, { schedule: exactSchedule })).toEqual(
    before,
  );
  expect(await f.service.listRuns(job.id)).toEqual([pending]);
  const edited = await f.service.update(job.id, {
    title: "Edited",
    timeZone: "Asia/Tokyo",
  });
  expect(edited.schedule).toEqual(job.schedule);
  expect(edited.nextRunAt).toBe(before!.nextRunAt);
  const [cancelled, replacement] = await f.service.listRuns(job.id);
  expect(cancelled).toMatchObject({ id: pending.id, status: "cancelled" });
  expect(replacement).toMatchObject({
    scheduledAt: pending.scheduledAt,
    trigger: pending.trigger,
    title: "Edited",
  });
});

test.each([60_000, Number.MAX_SAFE_INTEGER])(
  "file reads and restart retain a legacy timer deadline independently of stored delay %i",
  async (delayMs) => {
    const f = await fixture();
    const created = await f.service.create(input);
    const at = "2026-09-06T10:05:00.456Z";
    const stored = { kind: "timer" as const, delayMs, at };
    await f.store.update((state) => {
      state.jobs[0].schedule = stored;
      state.jobs[0].nextRunAt = at;
    });
    f.advance(10_000);
    expect((await f.readFresh()).jobs[0].schedule).toEqual(stored);
    const restarted = await f.restart();
    expect(await restarted.get(created.id)).toMatchObject({
      schedule: stored,
      nextRunAt: at,
    });
    const updated = await restarted.update(created.id, { title: "Preserved" });
    expect(updated.schedule).toEqual(stored);
    expect(updated.nextRunAt).toBe(at);
  },
);

test.each([undefined, "", "2026-09-06T10:05", "invalid"])(
  "stored timers reject missing or invalid canonical at %s without synthesizing a deadline",
  async (at) => {
    const f = await fixture();
    const job = await f.service.create(input);
    await expect(
      f.store.update((state) => {
        Object.assign(state.jobs[0].schedule, { at });
      }),
    ).rejects.toThrow();
    expect(await f.service.get(job.id)).toEqual(job);
  },
);

test("the Web route passes timer input through canonical normalization for create and update", async () => {
  const f = await fixture();
  const config = {
    models: {
      profiles: { model: { model: "test-model" } },
      defaults: { profileId: "model" },
    },
  } as unknown as RuntimeConfig;
  const routes = new ScheduleManagementRoutes(() => ({
    start: () => f.service.start(),
    services: { scheduler: f.service, config },
  }));
  let status = 0;
  let payload: { job?: { id: string; nextRunAt: string }; error?: string } = {};
  const response = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (raw: string) => {
      payload = JSON.parse(raw);
    },
  } as unknown as ServerResponse;
  const request = {
    url: new URL("http://local.test/web-api/schedules"),
    environmentId: "test",
    response,
  };
  await routes.handle({
    ...request,
    method: "POST",
    segments: ["schedules"],
    body: {
      ...input,
      schedule: { kind: "timer", delayMs: 60_000, at: "2099-01-01T00:00:00Z" },
    },
  });
  expect(status).toBe(201);
  expect(payload.job?.nextRunAt).toBe(new Date(f.now() + 60_000).toISOString());
  const jobId = payload.job!.id;
  await routes.handle({
    ...request,
    method: "PATCH",
    segments: ["schedules", jobId],
    body: {
      schedule: {
        kind: "timer",
        delayMs: Number.MAX_SAFE_INTEGER,
        at: "2099-01-01T00:00:00Z",
      },
    },
  });
  expect(status).toBe(400);
  expect(payload.error).toBe("scheduler_invalid_schedule");
});
