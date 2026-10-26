import { describe, expect, test } from "vitest";
import { buildToolCompletedEventMetadata, buildToolStartEventMetadata } from "../../capabilities/tool-event-metadata.js";
import type { ToolDefinition } from "../../capabilities/tool-types.js";
import { createSchedulingToolModule } from "../capabilities/scheduling/tool-module.js";
import type { RuntimeConfig } from "../ports.js";
import type { SchedulerService } from "../scheduler/contracts.js";
import { createConversationTools } from "../../web-ui/app/components/conversation-tools.js";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

const definition: ToolDefinition = {
  name: "schedules", params: {}, routingCapability: "semantic_mutation", executionEffect: "mixed",
  eventPresentation: createSchedulingToolModule({} as SchedulerService, {} as RuntimeConfig,
    async () => {}).definition.eventPresentation,
};

function event(meta: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { name: "tool.completed", requestId: "request", executionId: "execution",
    eventSequence: 2, tool: "schedules", ok: true, meta, ...overrides };
}

function declaredEvent(params: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const call = { tool: "schedules", params };
  const meta = overrides.name === "tool.started"
    ? buildToolStartEventMetadata(call, definition)
    : buildToolCompletedEventMetadata(call, { tool: "schedules", ok: overrides.ok !== false,
      output: '{"prompt":"PRIVATE SAVED TASK","result":"PRIVATE RESULT"}',
      producedNewInformation: true, progress: false }, definition);
  return event(meta || {}, overrides);
}

function actions(events: Record<string, unknown>[]) {
  return buildConversationToolActions({ requestId: "request", events, streaming: false });
}

function render(events: Record<string, unknown>[]) {
  const documentRoot = { createElement: (tag: string) =>
    Object.assign(new ContextElement(tag), { open: false, title: "" }) } as unknown as Document;
  return createConversationTools({ documentRoot }).createNode({ requestId: "request", actions: actions(events) })!;
}

describe("scheduling tool activity display", () => {
  test.each([
    ["list", "List schedules"], ["get", "Read schedule"],
    ["create", "Create schedule"], ["update", "Update schedule"],
    ["pause", "Pause schedule"], ["resume", "Resume schedule"],
    ["cancel", "Cancel schedule"], ["run_now", "Request schedule run"],
  ])("%s displays its accepted operation", (action, title) => {
    const events = [declaredEvent({ action })];
    expect(projectToolActivityEvent(events[0]!)!.activityTitle).toBe(title);
    expect(actions(events)[0]).toMatchObject({ title, status: "completed", preview: "" });
    expect(render(events).querySelector(".conversation-tool-summary")!.textContent).toContain(title);
  });

  test("a create lifecycle preserves title and timing kind without its task or returned data", () => {
    const params = { action: "create", title: "Daily news", scheduleKind: "daily",
      prompt: "PRIVATE TASK", unknown: "PRIVATE INPUT" };
    const events = [declaredEvent(params, { name: "tool.started", eventSequence: 1 }), declaredEvent(params)];
    const result = actions(events)[0]!;
    expect(result).toMatchObject({ title: "Create schedule", target: "Daily news", executed: true,
      received: [], preview: "", previewTruncated: false, partial: false });
    expect(result.sent).toEqual([{ label: "Action", value: "Create schedule" },
      { label: "Title", value: "Daily news" }, { label: "Schedule type", value: "Daily" }]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(render(events).querySelector(".conversation-tool-target")!.textContent).toBe("Daily news");
  });

  test("interleaved reads and updates keep their identities across replay", () => {
    const read = { action: "get", jobId: "job-one" };
    const update = { action: "update", jobId: "job-two", title: "New title" };
    const events = [declaredEvent(read, { name: "tool.started", executionId: "read", eventSequence: 1 }),
      declaredEvent(update, { name: "tool.started", executionId: "update", eventSequence: 2 }),
      declaredEvent(update, { executionId: "update", eventSequence: 3 }),
      declaredEvent(read, { executionId: "read", eventSequence: 4 })];
    const result = actions(events);
    expect(result.map(({ title, target }) => ({ title, target }))).toEqual([
      { title: "Read schedule", target: "job-one" }, { title: "Update schedule", target: "New title" }]);
    expect(result[1]!.sent).toContainEqual({ label: "Schedule ID", value: "job-two" });
    expect(actions(JSON.parse(JSON.stringify([...events, ...events])))).toEqual(result);
  });

  test("failures retain the attempted operation without claiming success", () => {
    const events = [declaredEvent({ action: "update", jobId: "job-one" },
      { name: "tool.failed", ok: false, error: "schedule_job_not_found" })];
    expect(actions(events)[0]).toMatchObject({ title: "Update schedule", target: "job-one",
      status: "failed", statusLabel: "Not completed", preview: "" });
    expect(actions(events)[0]!.received).toContainEqual({ label: "Error", value: "schedule_job_not_found" });
  });

  test("clipped input labels remain visibly clipped and do not claim partial tool results", () => {
    const events = [declaredEvent({ action: "update", jobId: "j".repeat(250), title: "t".repeat(250) })];
    expect(events[0]!.meta).toMatchObject({ scheduleTitleTruncated: true, scheduleJobIdTruncated: true });
    const result = actions(events)[0]!;
    expect(result.target).toBe(`${"t".repeat(199)}…`);
    expect(result.sent).toContainEqual({ label: "Schedule ID", value: `${"j".repeat(199)}…` });
    expect(result).toMatchObject({ previewTruncated: false, partial: false });
  });

  test("untrusted titles remain inert and directionally isolated", () => {
    const title = '<img src=x onerror="alert(1)"> חדשות';
    const rendered = render([declaredEvent({ action: "create", title })]);
    expect(rendered.querySelector("img")).toBeNull();
    expect(rendered.querySelector("script")).toBeNull();
    expect(rendered.querySelector(".conversation-tool-target")!.textContent).toBe(title);
    expect(rendered.querySelector(".conversation-tool-target")!.getAttribute("dir")).toBe("auto");
  });

  test("legacy, unknown and clipped actions are not guessed", () => {
    const metadata = [
      { params: { action: "string(len=4)", jobId: "string(len=36)" }, mutationEvidence: true },
      { scheduleAction: "constructor", scheduleTitle: "Unknown action" },
      { scheduleAction: "get", scheduleActionTruncated: true, scheduleJobId: "job-one" },
    ];
    for (const meta of metadata)
      expect(actions([event(meta)])[0]).toMatchObject({ title: "Schedules", target: "", sent: [], preview: "" });
  });

  test("schedule metadata cannot change another tool's display", () => {
    const original = event({ path: "notes.txt", outputPreview: "recorded text" }, { tool: "read_file" });
    const extra = { ...original, meta: { ...original.meta, scheduleAction: "cancel",
      scheduleTitle: "Other title", scheduleJobId: "other" } };
    expect(projectToolActivityEvent(extra)).toEqual(projectToolActivityEvent(original));
    expect(actions([extra])).toEqual(actions([original]));
  });

  test("approval evidence shows the saved target's tool access without a task prompt", () => {
    const approval = event({
      scheduleAction: "update", scheduleJobId: "job-one", scheduleTitle: "Daily news",
      scheduleToolPermissionMode: "full_plus", scheduleExpectedRevision: 3,
    }, { name: "tool.approval.required", approvalId: "approval-one" });
    const fields = projectToolActivityEvent(approval)!;
    expect(fields.sent).toContainEqual({ label: "Schedule tool access", value: "FULL+" });
    expect(fields.activityTitle).toBe("Update schedule");
    expect(fields.target).toBe("Daily news");
    const unknown = projectToolActivityEvent({ ...approval,
      meta: { ...approval.meta, scheduleToolPermissionMode: "untrusted-mode" } })!;
    expect(unknown.sent).not.toContainEqual(expect.objectContaining({ label: "Schedule tool access" }));
  });
});
