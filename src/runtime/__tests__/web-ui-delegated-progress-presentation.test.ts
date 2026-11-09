import { describe, expect, test } from "vitest";
import { enrichEventPayload } from "../events/event-status.js";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { buildConversationRoleCards } from "../../web-ui/app/lib/conversation-role-model.js";
import { buildConversationWorkTimeline } from "../../web-ui/app/lib/conversation-work-timeline-model.js";
import { buildEventTimelineEntries, isLowValueActivityEvent } from "../../web-ui/app/lib/event-presentation.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

type Event = Record<string, unknown>;
const requestId = "request-1";
const roleProgress = {
  planner: { phase: "planning", message: "Planning the delegated work...", label: "Planning The Delegated Work" },
  worker: { phase: "working", message: "Working on the delegated task...", label: "Working On The Delegated Task" },
  reviewer: { phase: "reviewing", message: "Auditing the recorded results...", label: "Auditing The Recorded Results" },
  supervisor: { phase: "resuming", message: "Processing the delegated result...", label: "Processing The Delegated Result" },
} as const;
const roles = ["planner", "worker", "reviewer", "supervisor"] as const;

function progress(role: typeof roles[number], sequence = 1): Event {
  return {
    type: "event", name: "runtime.state", stage: role,
    phase: roleProgress[role].phase, message: roleProgress[role].message,
    requestId, sessionId: "session-1", environment: "dev", generation: "one",
    eventSequence: sequence, seqNo: sequence,
  };
}

function activityEvents() {
  return [enrichEventPayload(progress("planner", 1)), enrichEventPayload(progress("worker", 2)), {
    type: "event", name: "tool.started", tool: "read_file",
    requestId, sessionId: "session-1", environment: "dev", generation: "one",
    eventSequence: 3, seqNo: 3,
  }, {
    type: "event", name: "tool.completed", tool: "read_file", ok: true,
    requestId, sessionId: "session-1", environment: "dev", generation: "one",
    eventSequence: 4, seqNo: 4, meta: { path: "report.txt", outputPreview: "Recorded file content" },
  }, enrichEventPayload(progress("reviewer", 5)), enrichEventPayload(progress("supervisor", 6))];
}

function assertPreservedRoleHandoffs(events: Event[]) {
  const model = buildConversationActivityModel({ requestId, events, streaming: true });
  expect(model.roleCards.map((card) => card.role)).toEqual(roles);
  for (const role of ["planner", "reviewer", "supervisor"]) {
    expect(model.roleCards.find((card) => card.role === role)?.summary).toBe("");
  }
  expect(model.roleCards.find((card) => card.role === "worker")).toMatchObject({ active: false, facts: ["1 read"] });
  expect(model.roleCards.filter((card) => card.active)).toMatchObject([{ role: "supervisor", tone: "active" }]);
  expect(model.events).toHaveLength(2);
  expect(model.toolCount).toBe(1);
  expect(model.failureCount).toBe(0);
  const timeline = buildConversationWorkTimeline({ requestId, events, streaming: true });
  expect(timeline).toHaveLength(6);
  expect(timeline.map((entry) => entry.role)).toEqual(["planner", "worker", "worker", "worker", "reviewer", "supervisor"]);
  expect(timeline[2]).toMatchObject({ kind: "event", role: "worker", event: { eventName: "tool.started" } });
  expect(timeline[3]).toMatchObject({ kind: "tool", role: "worker", action: { status: "completed", preview: "Recorded file content" } });
}

describe("delegated progress presentation", () => {
  test.each(roles)("hides generic %s labels in every projection while retaining the active role", (role) => {
    const raw = progress(role);
    const enriched = enrichEventPayload(raw);
    const projected = {
      ...enriched, eventName: enriched.name,
      name: roleProgress[role].label,
      summary: "", tone: "active",
    };
    const input = [raw, enriched, projected]; const before = structuredClone(input);
    for (const event of input) {
      // These events still carry role handoffs and must remain in realtime/session state.
      expect(isLowValueActivityEvent(event)).toBe(false);
      expect(buildEventTimelineEntries([event])).toEqual([]);
      expect(buildConversationWorkTimeline({ requestId, events: [event] }))
        .toMatchObject([{ kind: "event", role, event }]);
      expect(buildConversationActivityModel({ requestId, events: [event], streaming: true }))
        .toMatchObject({ eventCount: 0, failureCount: 0, latestLabel: "", currentLabel: "Working" });
      expect(buildConversationRoleCards({ requestId, events: [event], streaming: true }))
        .toMatchObject([{ role, summary: "", active: true, tone: "active" }]);
    }
    expect(input).toEqual(before);
  });

  test.each([
    { message: "Working on the selected files..." },
    { stage: "reviewer" }, { phase: "reviewing" },
    { type: "failed" }, { ok: false }, { status: "failed" },
    { error: "Cannot read the file" }, { tone: "failed" },
    { summary: "Checking the requested output" }, { output: "Read the requested output" },
    { reason: "Waiting for the selected target" },
    { name: "tool.started", tool: "read_file" },
    { name: "role.delegated" },
    { name: "user.interaction", text: "Working on the delegated task..." },
    { type: "user", text: "Working on the delegated task..." },
  ])("preserves meaningful, failed, tool and differently scoped evidence %#", (fields) => {
    const event = { ...progress("worker"), ...fields };
    expect(buildEventTimelineEntries([event])).toHaveLength(1);
    expect(buildConversationRoleCards({ requestId, events: [event] })
      .every((card) => card.summary !== "")).toBe(true);
  });

  test.each(roles)("preserves an actual error and custom %s progress after a hidden status", (role) => {
    const custom = { ...progress(role, 2), message: "Reviewing the requested changes" };
    expect(buildConversationRoleCards({ requestId, events: [progress(role), custom] })[0]?.summary)
      .toBe(custom.message);
    const failure = { ...progress(role, 2), ok: false, error: "File unavailable" };
    const model = buildConversationActivityModel({ requestId, events: [progress(role), failure], streaming: true });
    expect(model.events).toHaveLength(1);
    expect(model.failureCount).toBe(1);
    expect(model.roleCards[0]).toMatchObject({ role, active: false, tone: "failed" });
    expect(model.roleCards[0]?.summary).toContain("File unavailable");
  });

  test.each(roles)("retains an authored update with the same %s words", (role) => {
    const update = { id: "update-1", kind: "user_interaction", role: "assistant", requestId,
      text: roleProgress[role].label, eventSequence: 2 };
    const entries = buildConversationWorkTimeline({ requestId, events: [progress(role)], updates: [update] });
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ kind: "message", source: "interaction", text: update.text });
  });

  test("live statuses retain replay position and legacy tool ownership", () => {
    const f = createPlanLifecycleHarness();
    const input = activityEvents(); const before = structuredClone(input);
    for (const event of input) f.realtime.handle(event);
    expect(f.state.events).toHaveLength(6);
    expect(f.state.lastSeqByRequest.get(requestId)).toBe(6);
    expect(f.state.activeRequestId).toBe(requestId);
    assertPreservedRoleHandoffs(f.state.events);
    expect(input).toEqual(before);
  });

  test.each(["streaming", "completed"])("restored %s history keeps handoffs and exact final text", async (status) => {
    const input = activityEvents(); const before = structuredClone(input);
    const f = createPlanLifecycleHarness({ sessionId: "session-1", messages: [
      { id: "answer", role: "assistant", requestId, content: "Saved final answer" }],
    requests: [{ requestId, status, events: input,
      lifecycle: { schemaVersion: 1, requestId, generation: "one", revision: 1, status } }] });
    await f.conversationSession.openSession("session-1");
    expect(f.state.events).toHaveLength(6);
    expect(f.state.lastSeqByRequest.get(requestId)).toBe(6);
    expect(f.state.messages.find((message) => message.id === "answer")?.text).toBe("Saved final answer");
    assertPreservedRoleHandoffs(f.state.events);
    expect(input).toEqual(before);
  });
});
