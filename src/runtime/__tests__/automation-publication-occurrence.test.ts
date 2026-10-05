import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../ports.js";
import type { SchedulerScheduleInput } from "../scheduler/contracts.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import { validateAutomationPublication } from "../automations/publication-validation.js";
import { normalizeAutomationSchedule, requireAutomationScheduleOccurrence,
  type AutomationScheduleTiming } from "../scheduler/automation-schedule.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

const now = Date.parse("2026-09-30T08:00:00Z");
const fixtures: Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  vi.restoreAllMocks();
});

function ready(schedule: SchedulerScheduleInput, options: {
  now?: number; timeZone?: string; checkScheduleReadiness?: boolean; existingSchedule?: AutomationScheduleTiming;
} = {}) {
  const definition = createEmptyAutomationDefinition("scheduled", "Scheduled workflow");
  return validateAutomationPublication({
    definition: { ...definition, trigger: { kind: "schedule", schedule },
      body: { ...definition.body, children: [{ kind: "tool", id: "read", title: "Read", onFailure: "stop",
        operation: { toolName: "reader", operationId: "read", contractVersion: 1 }, controls: {} }] } },
    config: {} as RuntimeConfig, grantMode: "full_access", now, timeZone: "UTC", ...options,
    operations: [{ toolName: "reader", operationId: "read", contractVersion: 1,
      label: "Read", catalogGroups: [], permissionMode: "full_access", effect: "read_only",
      approval: "request_policy", input: { type: "object", properties: {}, required: [], additionalProperties: false } }],
  });
}

describe("automation publication occurrence readiness", () => {
  it.each(["2026-09-29T08:00:00Z", "2026-09-30T08:00:00Z", "2026-09-30T11:00:00+03:00"])(
    "reports an elapsed or exact-now one-shot %s before publication", (at) => {
      expect(ready({ kind: "once", at })).toEqual([expect.objectContaining({
        code: "scheduler_schedule_in_past", path: "trigger.schedule",
      })]);
    });

  it("accepts the next future instant and keeps the scheduler's occurrence identical", () => {
    const schedule = { kind: "once" as const, at: "2026-09-30T08:00:00.001Z" };
    expect(ready(schedule)).toEqual([]);
    expect(requireAutomationScheduleOccurrence(normalizeAutomationSchedule(schedule, now), "UTC", now))
      .toBe(schedule.at);
  });

  it("checks both interval occurrences even when its first occurrence is representable", () => {
    const clock = Date.parse("9999-12-31T23:59:58.000Z");
    const schedule = { kind: "interval" as const, everyMs: 1_000, anchorAt: "9999-12-31T23:59:59.000Z" };
    expect(ready(schedule, { now: clock })).toEqual([expect.objectContaining({
      code: "scheduler_invalid_schedule", path: "trigger.schedule",
    })]);
    expect(() => requireAutomationScheduleOccurrence(normalizeAutomationSchedule(schedule, clock), "UTC", clock))
      .toThrow("Interval recurrence is outside the supported date range");
  });

  it("checks calendar representability using the configured timezone", () => {
    const schedule = { kind: "daily" as const, at: "23:00" };
    const clock = Date.parse("9999-12-31T10:00:00Z");
    expect(ready(schedule, { now: clock, timeZone: "UTC" })).toEqual([]);
    expect(ready(schedule, { now: clock, timeZone: "Pacific/Kiritimati" })).toEqual([
      expect.objectContaining({ code: "scheduler_schedule_in_past", path: "trigger.schedule" }),
    ]);
  });

  it("returns an ordinary issue for an invalid publication timezone", () => {
    expect(ready({ kind: "daily", at: "09:00" }, { timeZone: "invalid/timezone" })).toEqual([
      expect.objectContaining({ code: "scheduler_invalid_timezone" }),
    ]);
  });

  it("preserves an unchanged absolute deadline across timezone metadata edits but rejects an elapsed new deadline", () => {
    const schedule = { kind: "once" as const, at: "2026-09-29T08:00:00.000Z" };
    const existingSchedule = { schedule, timeZone: "UTC" };
    expect(ready(schedule, { existingSchedule })).toEqual([]);
    expect(ready({ ...schedule, at: "2026-09-29T09:00:00Z" }, { existingSchedule })).toEqual([
      expect.objectContaining({ code: "scheduler_schedule_in_past" }),
    ]);
    expect(ready(schedule, { existingSchedule, timeZone: "Asia/Jerusalem" })).toEqual([]);
  });

  it("validates a calendar timezone edit even when its clock time is unchanged", () => {
    const schedule = { kind: "daily" as const, at: "23:00" };
    const clock = Date.parse("9999-12-31T10:00:00Z");
    expect(ready(schedule, { now: clock, timeZone: "Pacific/Kiritimati",
      existingSchedule: { schedule, timeZone: "UTC" } })).toEqual([
      expect.objectContaining({ code: "scheduler_schedule_in_past" }),
    ]);
  });

  it("preserves an exhausted stored interval only when its timing stays unchanged", () => {
    const schedule = { kind: "interval" as const, everyMs: 1_000, anchorAt: "9999-12-31T23:59:59.000Z" };
    const options = { now: Date.parse("9999-12-31T23:59:58.000Z"),
      existingSchedule: { schedule, timeZone: "UTC" } };
    expect(ready(schedule, options)).toEqual([]);
    expect(ready({ ...schedule, everyMs: 2_000 }, options)).toEqual([
      expect.objectContaining({ code: "scheduler_invalid_schedule" }),
    ]);
  });

  it("allows manual replay of elapsed frozen schedules while still rejecting malformed schedules", () => {
    expect(ready({ kind: "once", at: "2026-09-29T08:00:00Z" }, { checkScheduleReadiness: false })).toEqual([]);
    expect(ready({ kind: "daily", at: "25:00" }, { checkScheduleReadiness: false })).toEqual([
      expect.objectContaining({ code: "scheduler_exact_time_required" }),
    ]);
    expect(requireAutomationScheduleOccurrence({ kind: "manual" }, "UTC", now)).toBeNull();
  });

  it("reports readiness failure through Studio and never publishes an expired one-shot", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fixture = await createSchedulerRuntimeFixture("execution-agent-v1");
    fixtures.push(fixture);
    const studio = fixture.application.services.automations!;
    let draft = await studio.create("Expired one-shot");
    draft = await studio.updateDraft(draft.automationId, draft.revision, {
      kind: "add_node", parentSequenceId: draft.definition.body.id, index: 0,
      nodeWithoutId: { kind: "agent", title: "Report", onFailure: "stop",
        modelProfileId: "scheduled-model", agentMode: "reasoning", roleInstructions: "Report.",
        prompt: "Return a report.", inputs: {}, tools: [], result: { kind: "text" } },
    });
    draft = await studio.updateDraft(draft.automationId, draft.revision, {
      kind: "update_definition", patch: { trigger: { kind: "schedule",
        schedule: { kind: "once", at: "2026-09-29T08:00:00Z" } } },
    });
    const issues = await studio.validate(draft.automationId);
    expect(issues).toEqual([expect.objectContaining({ code: "scheduler_schedule_in_past" })]);
    await expect(studio.publish(draft.automationId, draft.revision)).rejects.toMatchObject({ issues });
    expect(await studio.getPublishedDefinition(draft.automationId)).toBeNull();
    expect(await studio.getDraft(draft.automationId)).toEqual(draft);
  });
});
