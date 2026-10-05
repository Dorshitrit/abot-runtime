import { afterEach, expect, test, vi } from "vitest";
import type { SchedulerScheduleInput } from "../scheduler/contracts.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

const fixtures: Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  vi.restoreAllMocks();
});

const publishedAt = Date.parse("2026-10-01T08:00:00Z");
const schedules: SchedulerScheduleInput[] = [
  { kind: "once", at: "2026-10-01T08:01:00Z" },
  { kind: "timer", delayMs: 60_000 },
];

test.each(schedules)("replays a published $kind workflow after its original occurrence has elapsed", async (schedule) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(publishedAt);
  const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
  fixtures.push(fixture);
  const studio = fixture.application.services.automations!;
  let draft = await studio.create("Replay after schedule deadline");
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "add_node", parentSequenceId: draft.definition.body.id, index: 0,
    nodeWithoutId: { kind: "agent", title: "Report", onFailure: "stop",
      modelProfileId: "scheduled-model", agentMode: "reasoning", roleInstructions: "Report.",
      prompt: "Return a report.", inputs: {}, tools: [], result: { kind: "text" } },
  });
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "update_definition", patch: { trigger: { kind: "schedule", schedule } },
  });
  const publication = await studio.publish(draft.automationId, draft.revision);
  const frozen = structuredClone(publication.definition);
  const first = await studio.runNow(draft.automationId);
  await expect.poll(async () => (await studio.getRun(first.id)).status,
    { timeout: 8_000, interval: 10 }).toBe("succeeded");

  clock.mockReturnValue(publishedAt + 120_000);
  expect(await studio.validate(draft.automationId)).toEqual([]);
  const replay = await studio.rerun(first.id, `repeat-${schedule.kind}`, true);
  expect(replay).toMatchObject({ replayOf: first.id, target: { definitionRevision: draft.revision } });
  await expect.poll(async () => (await studio.getRun(replay.id)).status,
    { timeout: 8_000, interval: 10 }).toBe("succeeded");
  const completed = await studio.getRun(replay.id);
  expect(completed.definition).toEqual(frozen.definition);
  expect(completed.report).toMatchObject({ outcome: "succeeded" });
  if (schedule.kind !== "once") return;
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "update_definition", patch: { title: "Updated title after the original occurrence" },
  });
  expect(await studio.validate(draft.automationId)).toEqual([]);
  const republished = await studio.publish(draft.automationId, draft.revision);
  expect(republished.job.schedule).toEqual(publication.job.schedule);
  expect(republished.job.nextRunAt).toEqual(publication.job.nextRunAt);
}, 20_000); // Two sequential 8-second polls, plus fixture setup and persistence.
