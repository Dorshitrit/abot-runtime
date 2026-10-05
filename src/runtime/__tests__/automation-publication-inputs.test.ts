import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../ports.js";
import type { AutomationCatalogOperation } from "../automations/catalog.js";
import type { AutomationRevision } from "../automations/definition-contracts.js";
import { DEFAULT_AUTOMATION_LIMITS } from "../automations/limits.js";
import { validateAutomationPublication } from "../automations/publication-validation.js";
import { parseAutomationDefinition } from "../automations/definition-input.js";
import { normalizeAutomationSchedule } from "../scheduler/automation-schedule.js";
import type { SchedulerScheduleInput } from "../scheduler/contracts.js";

const operation: AutomationCatalogOperation = {
  toolName: "fixture",
  operationId: "record",
  contractVersion: 1,
  label: "Record a result",
  catalogGroups: [],
  permissionMode: "full_access",
  effect: "read_only",
  approval: "request_policy",
  input: {
    type: "object", additionalProperties: false,
    properties: { query: { type: "string", minLength: 1, maxLength: 100 } },
    required: ["query"],
  },
  payload: { kind: "raw_text", param: "body", instructions: "Provide the text.", minBytes: 1, maxBytes: 100 },
};

function definition(controls: Record<string, { kind: "literal"; value: string }>,
  payload?: { kind: "literal"; value: string }): AutomationRevision {
  return {
    schemaVersion: 1, automationId: "example", revision: 1,
    title: "Example", objective: "Record a result", trigger: { kind: "manual" },
    inputs: {}, limits: DEFAULT_AUTOMATION_LIMITS,
    body: { kind: "sequence", id: "root", children: [{
      kind: "tool", id: "record", title: "Record", onFailure: "stop",
      operation: { toolName: "fixture", operationId: "record", contractVersion: 1 },
      controls, ...(payload ? { payload } : {}),
    }] },
  };
}

function validate(revision: AutomationRevision) {
  return validateAutomationPublication({
    definition: revision,
    config: {} as RuntimeConfig,
    operations: [operation],
    grantMode: "full_access",
    now: Date.parse("2026-09-30T08:00:00Z"), timeZone: "UTC",
  });
}

describe("automation publication tool inputs", () => {
  it("rejects an operation selected without its required inputs", () => {
    expect(validate(definition({}))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "automation_tool_input_missing", path: "nodes.record.controls.query" }),
      expect.objectContaining({ code: "automation_tool_input_missing", path: "nodes.record.payload" }),
    ]));
  });

  it("accepts a configured selected operation", () => {
    expect(validate(definition({ query: { kind: "literal", value: "invoice" } },
      { kind: "literal", value: "Checked" }))).toEqual([]);
  });

  it("rejects a blank literal even when the required binding exists", () => {
    expect(validate(definition({ query: { kind: "literal", value: "" } },
      { kind: "literal", value: "Checked" }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "automation_tool_input_invalid", path: "nodes.record.controls" }),
    ]));
  });
});

describe("automation publication schedule preflight", () => {
  const schedules: SchedulerScheduleInput[] = [
    { kind: "daily", at: "9:00" }, { kind: "daily", at: "25:00" },
    { kind: "weekly", at: "09:00", weekdays: [] }, { kind: "weekly", at: "09:00", weekdays: [7] },
    { kind: "monthly", at: "09:00", dayOfMonth: 32 },
    { kind: "interval", everyMs: 999 }, { kind: "timer", delayMs: 999 },
    { kind: "once", at: "2026-02-31T09:00:00Z" }, { kind: "once", at: "2026-10-01T09:00" },
  ];
  const configured = () => definition({ query: { kind: "literal", value: "invoice" } },
    { kind: "literal", value: "Checked" });

  it.each(schedules)("keeps an invalid $kind draft editable but reports the scheduler's rejection before publication", (schedule) => {
    const draft = parseAutomationDefinition({ ...configured(), trigger: { kind: "schedule", schedule } });
    let expected: Error & { code?: string };
    try { normalizeAutomationSchedule(schedule, Date.now()); throw new Error("expected_schedule_rejection"); }
    catch (error) { expected = error as Error & { code?: string }; }
    expect(expected.code).toBeDefined();
    expect(validate(draft)).toEqual([{ code: expected.code, message: expected.message, path: "trigger.schedule" }]);
  });

  it.each<SchedulerScheduleInput>([
    { kind: "daily", at: "09:00" }, { kind: "weekly", at: "09:00", weekdays: [0, 6] },
    { kind: "monthly", at: "09:00", dayOfMonth: 31 }, { kind: "interval", everyMs: 1_000 },
    { kind: "timer", delayMs: 1_000 }, { kind: "once", at: "2026-10-01T09:00:00Z" },
  ])("accepts a canonical $kind schedule without changing its stored input", (schedule) => {
    const draft = { ...configured(), trigger: { kind: "schedule" as const, schedule } };
    const before = structuredClone(draft);
    expect(validate(draft)).toEqual([]);
    expect(draft).toEqual(before);
  });

  it("validates a folder polling interval with the same scheduler rules", () => {
    const draft: AutomationRevision = { ...configured(),
      trigger: { kind: "folder", checkEveryMs: 999, minimumEligibleFiles: 1 },
      source: { sourceId: "inbox", location: { kind: "runtime_path", path: "/workspace/inbox" }, mode: "per_file", maxBatchFiles: 1,
        includePatterns: [], excludePatterns: [], recursive: false, includeExisting: false },
    };
    expect(validate(draft)).toEqual([expect.objectContaining({ code: "scheduler_invalid_schedule", path: "trigger.checkEveryMs" })]);
    expect(validate({ ...draft, trigger: { ...draft.trigger, kind: "folder", checkEveryMs: 1_000, minimumEligibleFiles: 1 } })).toEqual([]);
  });

  it("uses the publication owner's clock when validating relative deadline bounds", () => {
    const definition: AutomationRevision = { ...configured(),
      trigger: { kind: "schedule", schedule: { kind: "timer", delayMs: 1_000 } },
    };
    const input = { definition, config: {} as RuntimeConfig, operations: [operation],
      grantMode: "full_access" as const, now: Date.parse("9999-12-31T23:59:59.999Z") };
    expect(validateAutomationPublication(input)).toEqual([expect.objectContaining({
      code: "scheduler_invalid_schedule", path: "trigger.schedule",
    })]);
    expect(validateAutomationPublication({ ...input, now: Date.parse("2026-09-30T08:00:00Z") })).toEqual([]);
  });
});
