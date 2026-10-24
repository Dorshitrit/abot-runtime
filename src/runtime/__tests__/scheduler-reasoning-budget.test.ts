import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type {
  SchedulerExecutor,
  SchedulerService,
} from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const preference = {
  profileId: "scheduled-model",
  mode: "budget",
  budgetTokens: 256,
} as const;

test("scheduled reasoning survives storage, pending replacement and explicit clearing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-reasoning-"));
  let busy = true;
  const start = vi.fn<SchedulerExecutor["start"]>(async () => ({
    status: "succeeded",
  }));
  const options = {
    environmentId: "test",
    store: createFileSchedulerStore(directory),
    tickIntervalMs: 1_000_000,
    executor: {
      sessionExists: async () => true,
      tryReserve: () => (busy ? null : () => undefined),
      start,
    },
  };
  let service: SchedulerService = createSchedulerService(options);
  cleanups.push(async () => {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await service.start();
  const job = await service.create({
    sessionId: "session",
    title: "Think",
    prompt: "Answer",
    modelProfileId: preference.profileId,
    agentMode: "fast",
    reasoningPreference: preference,
    timeZone: "UTC",
    schedule: { kind: "timer", delayMs: 3_600_000 },
  });
  await service.stop();
  service = createSchedulerService(options);
  await service.start();
  expect((await service.get(job.id))?.reasoningPreference).toEqual(preference);
  await service.runNow(job.id);
  const unchanged = await service.update(job.id, {
    reasoningPreference: { ...preference },
  });
  expect(unchanged.revision).toBe(job.revision);
  const edited = await service.update(job.id, { title: "New title" });
  expect(edited.reasoningPreference).toEqual(preference);
  const cleared = await service.update(job.id, { reasoningPreference: null });
  expect(cleared.reasoningPreference).toBeUndefined();
  const runs = await service.listRuns(job.id);
  expect(
    runs
      .filter((run) => run.status === "cancelled")
      .every((run) => run.reasoningPreference?.mode === "budget"),
  ).toBe(true);
  expect(runs.at(-1)?.reasoningPreference).toBeUndefined();
  busy = false;
  await service.tick();
  expect(start).toHaveBeenCalledOnce();
  expect(start.mock.calls[0][0].reasoningPreference).toBeUndefined();
  expect(start.mock.calls[0][1].reasoningPreference).toBeUndefined();
  await expect(
    service.update(job.id, {
      reasoningPreference: { ...preference, profileId: "other" },
    }),
  ).rejects.toThrow();
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s scheduled requests carry the captured reasoning choice to model invocations",
  async (policy) => {
    const fixture = await createSchedulerRuntimeFixture(policy);
    cleanups.push(fixture.dispose);
    fixture.config.models!.providers!.local.type = "llamacpp";
    fixture.config.models!.profiles!["scheduled-model"].supportsThinking = true;
    const job = await fixture.createJob();
    await fixture.scheduler.update(job.id, { reasoningPreference: preference });
    const run = await fixture.scheduler.runNow(job.id);
    await fixture.scheduler.tick();
    expect((await fixture.waitForRun(run.id)).status).toBe("succeeded");
    expect(fixture.invoke).toHaveBeenCalled();
    for (const [input] of fixture.invoke.mock.calls)
      expect(input.reasoningPreference).toEqual(preference);
  },
);
