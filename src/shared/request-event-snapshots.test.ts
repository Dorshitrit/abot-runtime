import { expect, test } from "vitest";
import {
  appendRequestReplayEvent,
  canReplaceRequestEventSnapshot,
  mergePendingRequestSnapshot,
} from "./request-event-snapshots.js";

function thinking(text: string, delta = text, extra: Record<string, unknown> = {}) {
  return { type: "event", name: "thinking.delta", requestId: "request", text, delta, ...extra };
}

test("replay replaces a cumulative tail and retains its latest cursor", () => {
  const events: Record<string, unknown>[] = [];
  appendRequestReplayEvent(events, thinking("a", "a", { seqNo: 1 }));
  appendRequestReplayEvent(events, thinking("ab", "b", { seqNo: 2 }));
  expect(events).toEqual([thinking("ab", "b", { seqNo: 2 })]);
});

test.each(["requestId", "sessionId", "environment", "environmentId", "generation", "activationId"])(
  "snapshots cannot replace another %s scope",
  (field) => {
    expect(canReplaceRequestEventSnapshot(thinking("a", "a", { [field]: "old" }),
      thinking("ab", "b", { [field]: "new" }))).toBe(false);
  },
);

test("acknowledgements and semantic events remain replay boundaries", () => {
  const events: Record<string, unknown>[] = [];
  const acknowledgement = thinking("Working", "Working", { presentationKind: "acknowledgement" });
  const tool = { type: "event", name: "tool.completed", requestId: "request" };
  for (const event of [thinking("a"), acknowledgement, thinking("ab", "b"), tool, thinking("abc", "c")]) {
    appendRequestReplayEvent(events, event);
  }
  expect(events).toHaveLength(5);
  expect(events[1]).toBe(acknowledgement);
  expect(events[3]).toBe(tool);
});

test("replay preserves text resets and noncumulative token events", () => {
  const events: Record<string, unknown>[] = [];
  for (const event of [thinking("abc"), thinking("x"),
    { type: "event", name: "token", text: "a" }, { type: "event", name: "token", text: "ab" }]) {
    appendRequestReplayEvent(events, event);
  }
  expect(events).toHaveLength(4);
});

test("pending thinking keeps both cumulative and delta-only delivery complete", () => {
  const merged = mergePendingRequestSnapshot(thinking("אב", "ב"), thinking("אבג", "ג", { eventSequence: 3 }));
  expect(merged).toMatchObject({ text: "אבג", delta: "בג", eventSequence: 3 });
  expect(mergePendingRequestSnapshot(merged!, thinking("אבגד", "ד"))).toMatchObject({ text: "אבגד", delta: "בגד" });
});

test.each([
  thinking("ab", "duplicate"),
  thinking("ab", ""),
  thinking("ab", "b", { delta: undefined }),
  thinking("ab", "b", { presentationKind: "acknowledgement" }),
])("inconsistent or special deltas are retained separately", (next) => {
  expect(mergePendingRequestSnapshot(thinking("a"), next)).toBeUndefined();
});

test("legacy cumulative answer snapshots may coalesce without inventing a delta", () => {
  const previous = { type: "token", requestId: "request", text: "a" };
  const next = { type: "token", requestId: "request", text: "ab" };
  expect(mergePendingRequestSnapshot(previous, next)).toBe(next);
});
