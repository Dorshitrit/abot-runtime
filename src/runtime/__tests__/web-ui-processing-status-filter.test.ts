import { expect, test } from "vitest";
import { enrichEventPayload } from "../events/event-status.js";
import { isLowValueActivityEvent, buildEventTimelineEntries } from "../../web-ui/app/lib/event-presentation.js";
import { buildConversationWorkTimeline } from "../../web-ui/app/lib/conversation-work-timeline-model.js";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const requestId = "request-1";
function processing(sequence = 1) {
  return { type: "event", name: "runtime.state", stage: "supervisor", phase: "working",
    message: "Processing the request...", requestId, sessionId: "session-1", environment: "dev",
    generation: "one", eventSequence: sequence, seqNo: sequence };
}
function events() {
  return [enrichEventPayload(processing(1)),
    { type: "event", name: "Read project instructions", stage: "supervisor", phase: "skills", requestId, eventSequence: 2, seqNo: 2 },
    enrichEventPayload(processing(3)),
    { type: "event", name: "tool.completed", tool: "read_file", executorRole: "supervisor", executionId: "read-one", ok: true,
      requestId, eventSequence: 4, seqNo: 4, meta: { path: "instructions.txt", outputPreview: "Meaningful tool evidence" } },
    enrichEventPayload(processing(5))];
}

test("filters only the canonical generic runtime state across raw, enriched and projected UI forms", () => {
  const raw = processing();
  const enriched = enrichEventPayload(raw);
  const projected = { ...enriched, eventName: enriched.name, name: "Processing The Request", summary: "", tone: "active" };
  const before = structuredClone([raw, enriched, projected]);
  for (const event of [raw, enriched, projected]) {
    expect(isLowValueActivityEvent(event)).toBe(true);
    expect(buildEventTimelineEntries([event])).toEqual([]);
    expect(buildConversationWorkTimeline({ requestId, events: [event] })).toEqual([]);
    expect(buildConversationActivityModel({ requestId, events: [event] })).toMatchObject({ eventCount: 0, latestLabel: "" });
  }
  expect([raw, enriched, projected]).toEqual(before);
  expect(raw.name).toBe("runtime.state");
  expect(enriched.name).toBe("Processing the request...");
});

test.each([
  { message: "Processing the requested files..." },
  { stage: "worker" }, { phase: "reviewing" },
  { type: "failed" }, { ok: false }, { status: "failed" }, { error: "Action failed" }, { tone: "failed" },
  { name: "tool.started", tool: "read_file" },
  { name: "role.delegated" },
])("keeps meaningful or differently scoped events %#", (fields) => {
  const event = { ...processing(), ...fields };
  expect(isLowValueActivityEvent(event)).toBe(false);
  expect(buildEventTimelineEntries([event])).toHaveLength(1);
});

test("live processing statuses advance replay position without adding Agents event rows", () => {
  const f = createPlanLifecycleHarness();
  const input = events(); const before = structuredClone(input);
  for (const event of input) f.realtime.handle(event);
  expect(f.state.lastSeqByRequest.get(requestId)).toBe(5);
  expect(f.state.activeRequestId).toBe(requestId);
  expect(f.state.events).toHaveLength(2);
  expect(buildConversationWorkTimeline({ requestId, events: f.state.events }).map((entry) => entry.kind)).toEqual(["skill", "tool"]);
  expect(input).toEqual(before);
});

test.each(["streaming", "completed"])("restored %s history has live filtering parity and keeps the replay cursor", async (status) => {
  const input = events();
  const f = createPlanLifecycleHarness({ sessionId: "session-1", messages: [
    { id: "answer", role: "assistant", requestId, content: "Saved answer" }],
  requests: [{ requestId, status, events: input, lifecycle: { schemaVersion: 1, requestId, generation: "one", revision: 1, status } }] });
  await f.conversationSession.openSession("session-1");
  const live = createPlanLifecycleHarness();
  for (const event of input) live.realtime.handle(event);
  expect(buildConversationWorkTimeline({ requestId, events: f.state.events })).toEqual(buildConversationWorkTimeline({ requestId, events: live.state.events }));
  expect(f.state.lastSeqByRequest.get(requestId)).toBe(5);
  expect(f.state.events).toHaveLength(2);
  expect(f.state.messages.find((message) => message.id === "answer")?.text).toBe("Saved answer");
});
