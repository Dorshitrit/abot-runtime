import { afterEach, expect, test, vi } from "vitest";
import type { ModelReasoningPreference } from "../../shared/model-reasoning.js";
import type { CreateSchedulerJobInput, SchedulerSnapshot, SchedulerStore } from "../scheduler/contracts.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const preferences: ModelReasoningPreference[] = [
  { profileId: "scheduled-model", mode: "off" },
  { profileId: "scheduled-model", mode: "server-default" },
  { profileId: "scheduled-model", mode: "budget", budgetTokens: 128 },
];
const jobInput = {
  sessionId: "session", title: "Reminder", prompt: "Remind me to act",
  modelProfileId: "scheduled-model", agentMode: "fast" as const,
  timeZone: "UTC", schedule: { kind: "timer" as const, delayMs: 3_600_000 },
};

test.each(["openai", "ollama", "llamacpp"] as const)(
  "%s without numeric reasoning support rejects explicit controls before saving",
  async (provider) => {
    const f = await createSchedulerRuntimeFixture();
    cleanups.push(f.dispose);
    f.config.models!.providers!.local.type = provider;
    f.config.models!.profiles!["scheduled-model"].supportsThinking = provider !== "llamacpp";
    for (const reasoningPreference of preferences) {
      await expect(f.scheduler.create({ ...jobInput, reasoningPreference }))
        .rejects.toThrow("reasoning_budget_unsupported");
      expect(await f.scheduler.list()).toEqual([]);
    }
    const job = await f.scheduler.create(jobInput);
    for (const reasoningPreference of preferences) {
      await expect(f.scheduler.update(job.id, { title: "Must not persist", reasoningPreference }))
        .rejects.toThrow("reasoning_budget_unsupported");
      expect(await f.scheduler.get(job.id)).toEqual(job);
    }
    expect(await f.scheduler.listRuns()).toEqual([]);
    expect(f.invoke).not.toHaveBeenCalled();
  },
);

test("supported controls survive edits, while explicit clearing repairs an incompatible saved preference", async () => {
  const f = await createSchedulerRuntimeFixture();
  cleanups.push(f.dispose);
  f.config.models!.providers!.local.type = "llamacpp";
  f.config.models!.profiles!["scheduled-model"].supportsThinking = true;
  for (const reasoningPreference of preferences) {
    const job = await f.scheduler.create({ ...jobInput, reasoningPreference });
    const renamed = await f.scheduler.update(job.id, { title: "Renamed" });
    expect(renamed.reasoningPreference).toEqual(reasoningPreference);
    expect(renamed.revision).toBe(job.revision + 1);
  }
  const job = (await f.scheduler.list())[0]!;
  f.config.models!.providers!.local.type = "openai";
  await expect(f.scheduler.update(job.id, { title: "Invalid retained controls" }))
    .rejects.toThrow("reasoning_budget_unsupported");
  expect(await f.scheduler.get(job.id)).toEqual(job);
  const cleared = await f.scheduler.update(job.id, { reasoningPreference: null });
  expect(cleared.reasoningPreference).toBeUndefined();
  expect(cleared.revision).toBe(job.revision + 1);
  expect((await f.scheduler.update(job.id, { title: "Compatible" })).title).toBe("Compatible");
  expect(f.invoke).not.toHaveBeenCalled();
});

test("editing validates the requested new model, not the saved model's reasoning support", async () => {
  const f = await createSchedulerRuntimeFixture();
  cleanups.push(f.dispose);
  f.config.models!.providers!.local.type = "llamacpp";
  f.config.models!.profiles!["scheduled-model"].supportsThinking = true;
  f.config.models!.providers!.cloud = { type: "openai" };
  f.config.models!.profiles!.cloud = {
    provider: "cloud", model: "cloud", supportsThinking: true, contextWindowTokens: 8000,
  };
  const job = await f.scheduler.create({ ...jobInput, reasoningPreference: preferences[0] });
  await expect(f.scheduler.update(job.id, { modelProfileId: "cloud", reasoningPreference: {
    profileId: "cloud", mode: "off",
  } })).rejects.toThrow("reasoning_budget_unsupported");
  expect(await f.scheduler.get(job.id)).toEqual(job);
  await expect(f.scheduler.update(job.id, { modelProfileId: "cloud" }))
    .rejects.toThrow("reasoning_preference_profile_mismatch");
  const switched = await f.scheduler.update(job.id, { modelProfileId: "cloud", reasoningPreference: null });
  expect(switched).toMatchObject({ modelProfileId: "cloud", revision: job.revision + 1 });
  expect(switched.reasoningPreference).toBeUndefined();
});

test("rejected candidate validation preserves the Job and every pending run snapshot", async () => {
  let snapshot: SchedulerSnapshot = { schemaVersion: 1, jobs: [], runs: [] };
  const store: SchedulerStore = {
    acquire: async () => async () => undefined,
    read: async () => structuredClone(snapshot),
    update: async (mutate) => {
      const next = structuredClone(snapshot);
      const result = mutate(next);
      snapshot = next;
      return result;
    },
  };
  const validateRequestJob = vi.fn((input: Readonly<CreateSchedulerJobInput>) => {
    if (input.reasoningPreference) throw new Error("unsupported_test_preference");
  });
  const service = createSchedulerService({
    environmentId: "test", store, tickIntervalMs: 1_000_000,
    executor: { sessionExists: async () => true, tryReserve: () => null,
      start: async () => ({ status: "succeeded" }), validateRequestJob },
  });
  cleanups.push(() => service.stop());
  await service.start();
  const job = await service.create(jobInput);
  const pending = await service.runNow(job.id);
  const before = structuredClone(snapshot);
  await expect(service.update(job.id, { title: "Rejected", reasoningPreference: preferences[0] }))
    .rejects.toThrow("unsupported_test_preference");
  expect(snapshot).toEqual(before);
  expect(await service.listRuns(job.id)).toEqual([pending]);
  expect(validateRequestJob.mock.calls.at(-1)?.[0]).toMatchObject({
    ...jobInput, title: "Rejected", reasoningPreference: preferences[0],
  });
  const renamed = await service.update(job.id, { title: "Accepted" });
  expect(renamed.revision).toBe(job.revision + 1);
});
