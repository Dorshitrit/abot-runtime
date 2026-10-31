import type { ContextWindowState } from "../../web-ui/app/lib/context-window-state.js";
import { afterEach, expect, test, vi } from "vitest";
import { createRealtimeContextHarness } from "./support/realtime-context-harness.js";
import { buildConversationStatus } from "../../web-ui/app/lib/conversation-status-model.js";
// @ts-expect-error Browser component.
import { createConversationStatus } from "../../web-ui/app/components/conversation-status.js";
import { createComposerContextDom } from "./support/composer-context-window-dom.js";

afterEach(() => vi.useRealTimers());
const base = { type: "event", requestId: "request-1", invocationId: "outer-1", modelStep: "execution.decision" };
const start = { ...base, name: "context.compaction.started", eventSequence: 1 };
const progress = { ...base, name: "context.compaction.progress", eventSequence: 2, step: "processing",
  status: "Compacting context · 2/5 sources processed", completedUnits: 2, totalUnits: 5, progressAt: 1000 };

test("live/replayed progress updates one cycle without replacing lifecycle or reopening terminal work", () => {
  const { controller, state } = createRealtimeContextHarness();
  controller.handle(start);
  controller.handle(progress);
  const current = () => state.contextWindowByRequest.get("request-1") as ContextWindowState;
  expect(current().pendingCompaction!.progress).toMatchObject({ completedUnits: 2, totalUnits: 5 });
  expect(buildConversationStatus({ requestId: "request-1", streaming: true, contextWindow: current() })).toMatchObject({ label: progress.status });
  controller.handle({ ...progress, eventSequence: 1, seqNo: 99, completedUnits: 0 });
  controller.handle({ ...progress, seqNo: 100 });
  controller.handle({ ...progress, eventSequence: 3, requestId: "another" });
  expect(current().pendingCompaction!.progress).toMatchObject({ completedUnits: 2, eventSequence: 2 });
  controller.handle({ ...base, name: "context.compaction.completed", eventSequence: 4 });
  controller.handle({ ...progress, eventSequence: 5 });
  expect(current().pendingCompaction).toBeNull();
  expect(current().cycles.get("outer-1")!.status).toBe("completed");
});

test("parallel cycles stay separate and request cancellation fences later progress", () => {
  const { controller, state } = createRealtimeContextHarness();
  controller.handle(start);
  controller.handle({ ...start, invocationId: "outer-2", eventSequence: 2 });
  controller.handle({ ...progress, eventSequence: 3 });
  controller.handle({ ...progress, invocationId: "outer-2", eventSequence: 4, completedUnits: 1 });
  const current = () => state.contextWindowByRequest.get("request-1") as ContextWindowState;
  expect(current().cycles.get("outer-1")!.progress!.completedUnits).toBe(2);
  expect(current().cycles.get("outer-2")!.progress!.completedUnits).toBe(1);
  controller.handle({ type: "failed", requestId: "request-1", eventSequence: 5, error: "request_cancelled" });
  controller.handle({ ...progress, eventSequence: 6 });
  expect(current().pendingCompaction).toBeNull();
});

test("status clock updates the existing node and stops after completion or reset", () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const dom = createComposerContextDom();
  const message = { id: "a", requestId: "request-1", role: "assistant", streaming: true };
  const contextWindow = { requestId: "request-1", pendingCompaction: { progress } };
  const status = createConversationStatus({ getActiveRequestId: () => "request-1",
    getActivityForMessage: () => ({ contextWindow }), documentRoot: dom.documentRoot });
  const node = status.createNode(message); dom.container.appendChild(node);
  vi.advanceTimersByTime(3000);
  expect(node.textContent).toContain("updated 3s ago");
  expect(dom.container.children).toEqual([node]);
  message.streaming = false; status.render();
  expect(node.hidden).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  message.streaming = true; status.render();
  expect(vi.getTimerCount()).toBe(1);
  status.reset(); expect(vi.getTimerCount()).toBe(0);
});
