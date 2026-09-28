import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("the existing scheduled stream announces job writes and the final committed run after its request terminal", async () => {
  const f = await createSchedulerRuntimeFixture();
  cleanups.push(f.dispose);
  const reader = createFileSchedulerStore(
    join(f.config.paths.runtimeDir, "scheduler"),
  );
  const committedReads: Promise<SchedulerRun[]>[] = [];
  f.application.subscribeScheduledEvents((event) => {
    if (event.name === "scheduler.changed")
      committedReads.push(reader.readRuns!());
  });
  const job = await f.createJob();
  expect(f.events).toEqual([
    {
      type: "event",
      name: "scheduler.changed",
      environment: f.config.runtimeId,
    },
  ]);
  expect((await reader.read()).jobs[0].id).toBe(job.id);
  const run = await f.scheduler.runNow(job.id);
  await f.scheduler.tick();
  await f.waitForRun(run.id);
  const terminalIndex = f.events.findIndex(
    (event) => event.type === "completed" && event.requestId === run.requestId,
  );
  const changedIndices = f.events.flatMap((event, index) =>
    event.name === "scheduler.changed" ? [index] : [],
  );
  expect(terminalIndex).toBeGreaterThanOrEqual(0);
  expect(changedIndices.at(-1)).toBeGreaterThan(terminalIndex);
  const finalRead = await committedReads.at(-1)!;
  expect(finalRead.find((entry) => entry.id === run.id)).toMatchObject({
    status: "succeeded",
    resultMessageId: expect.any(String),
  });
  const count = changedIndices.length;
  await f.scheduler.tick();
  await f.scheduler.list();
  await f.scheduler.listRuns();
  expect(
    f.events.filter((event) => event.name === "scheduler.changed"),
  ).toHaveLength(count);
});
