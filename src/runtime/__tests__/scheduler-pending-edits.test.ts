import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SchedulerExecutor,
  SchedulerService,
} from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";

const resources: { service: SchedulerService; directory: string }[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "abot-scheduler-edit-"));
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
    title: "Original",
    prompt: "Original work",
    modelProfileId: "original-model",
    agentMode: "fast",
    timeZone: "UTC",
    schedule: { kind: "timer", delayMs: 1_000 },
  });
  return {
    service,
    job,
    start,
    freeSession: () => {
      busy = false;
    },
    advance: (ms = 1_000) => {
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
describe("scheduler pending edit preservation", () => {
  it("replaces a busy one-shot snapshot after title/prompt/model edits without dropping its occurrence", async () => {
    const f = await fixture();
    f.advance();
    await f.service.tick();
    const [original] = await f.service.listRuns(f.job.id);
    const edited = await f.service.update(f.job.id, {
      title: "Updated",
      prompt: "Updated work",
      modelProfileId: "new-model",
      agentMode: "deep",
    });
    const runs = await f.service.listRuns(f.job.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      id: original.id,
      status: "cancelled",
      modelProfileId: "original-model",
      jobRevision: 1,
    });
    expect(runs[1]).toMatchObject({
      status: "pending",
      scheduledAt: original.scheduledAt,
      trigger: original.trigger,
      title: "Updated",
      prompt: "Updated work",
      modelProfileId: "new-model",
      agentMode: "deep",
      timeZone: "UTC",
      jobRevision: edited.revision,
    });
    f.freeSession();
    await f.service.tick();
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.start.mock.calls[0][0]).toMatchObject({
      prompt: "Updated work",
      modelProfileId: "new-model",
      agentMode: "deep",
    });
  });
  it("leaves pending identity and revision unchanged for empty and identical updates", async () => {
    const f = await fixture();
    f.advance();
    await f.service.tick();
    const before = await f.service.get(f.job.id);
    const [pending] = await f.service.listRuns(f.job.id);
    expect(await f.service.update(f.job.id, {})).toEqual(before);
    expect(
      await f.service.update(f.job.id, {
        title: f.job.title,
        schedule: f.job.schedule,
      }),
    ).toEqual(before);
    expect(await f.service.listRuns(f.job.id)).toEqual([pending]);
    f.freeSession();
    await f.service.tick();
    expect(f.start.mock.calls[0][1].id).toBe(pending.id);
  });
  it("replaces old pending timing with a future occurrence when timing is edited", async () => {
    const f = await fixture();
    f.advance();
    await f.service.tick();
    await f.service.update(f.job.id, {
      schedule: { kind: "timer", delayMs: 10_000 },
    });
    expect(
      (await f.service.listRuns(f.job.id)).map((run) => run.status),
    ).toEqual(["cancelled"]);
    f.freeSession();
    await f.service.tick();
    expect(f.start).not.toHaveBeenCalled();
    f.advance(10_000);
    await f.service.tick();
    expect(f.start).toHaveBeenCalledOnce();
  });
  it("retains manual pending work when resuming a paused Job", async () => {
    const f = await fixture();
    await f.service.pause(f.job.id);
    const manual = await f.service.runNow(f.job.id);
    await f.service.resume(f.job.id);
    expect(await f.service.listRuns(f.job.id)).toEqual([manual]);
    await f.service.resume(f.job.id);
    expect(await f.service.listRuns(f.job.id)).toEqual([manual]);
    f.freeSession();
    await f.service.tick();
    expect(f.start.mock.calls[0][1].id).toBe(manual.id);
  });
});
