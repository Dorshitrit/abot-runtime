import { expect, test } from "vitest";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { createRealtimeContextHarness } from "./support/realtime-context-harness.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const lifecycle = {
  schemaVersion: 1, requestId: "request-1", generation: "generation-1",
  revision: 1, status: "streaming",
};
const titleEvent = {
  type: "event", name: "session.title.updated", sessionId: "session-1",
  requestId: "request-1", title: "Updated conversation title", seqNo: 1,
};
const lifecycleEvent = {
  type: "event", name: "request.lifecycle.changed", sessionId: "session-1",
  requestId: "request-1", lifecycle, seqNo: 2,
};

test("live title and lifecycle updates still apply without housekeeping activity rows", () => {
  const h = createRealtimeContextHarness();
  h.controller.handle(titleEvent);
  expect(h.applySessionTitleUpdate).toHaveBeenCalledExactlyOnceWith("session-1", titleEvent.title);
  h.assistant.streaming = false;
  h.controller.handle(lifecycleEvent);
  expect(h.state.requestLifecycles.get("request-1")).toEqual(lifecycle);
  expect(h.assistant.streaming).toBe(true);
  const completed = { ...lifecycle, status: "completed", revision: 2 };
  h.controller.handle({ ...lifecycleEvent, lifecycle: completed, seqNo: 3 });
  expect(h.state.requestLifecycles.get("request-1")).toEqual(completed);
  expect(h.assistant.streaming).toBe(false);
  expect(h.state.lastSeqByRequest.get("request-1")).toBe(3);
  expect(h.state.events).toEqual([]);
  expect(h.renderMessages).toHaveBeenCalled();
});

test("historical housekeeping events are hidden while replay cursors and request failures remain", async () => {
  const completed = { ...lifecycle, status: "completed", revision: 2 };
  const events = [titleEvent, { ...lifecycleEvent, lifecycle: completed }, {
    type: "event", name: "request.failed", requestId: "request-1",
    sessionId: "session-1", error: "Provider unavailable", seqNo: 3,
  }];
  const original = JSON.stringify(events);
  const h = createPlanLifecycleHarness({
    sessionId: "session-1", title: titleEvent.title,
    messages: [{ id: "answer", role: "assistant", content: "Saved answer", requestId: "request-1" }],
    requests: [{ requestId: "request-1", status: "completed", lifecycle: completed, events,
      finalState: { status: "completed", output: "Saved answer" } }],
  });
  await h.conversationSession.openSession("session-1");
  expect(h.state.requestLifecycles!.get("request-1")).toEqual(completed);
  expect(h.state.lastSeqByRequest.get("request-1")).toBe(3);
  const model = buildConversationActivityModel({ requestId: "request-1", events: h.state.events });
  expect(model.events.map(event => event.eventName)).toEqual(["request.failed"]);
  expect(model.failureCount).toBe(1);
  expect(JSON.stringify(events)).toBe(original);
});

test("background replay tracks a title-only event without creating an activity row", () => {
  const h = createRealtimeContextHarness();
  h.controller.recordEvent(titleEvent);
  expect(h.state.lastSeqByRequest.get("request-1")).toBe(1);
  expect(h.state.events).toEqual([]);
});
