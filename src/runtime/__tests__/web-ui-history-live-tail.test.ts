import { expect, test } from "vitest";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";
import { normalizeConversationMessage } from "../../web-ui/app/controllers/conversation-session-controller.js";
// @ts-expect-error Browser projection.
import { mergeHistoryPage } from "../../web-ui/app/lib/history-page-messages.js";

const raw = (id: number) => ({ id, role: "assistant", text: `Answer ${id}`, createdAt: id, requestId: `req-${id}` });
async function fixture() {
  const f = createPlanLifecycleHarness({
    messages: [raw(1), raw(2)], requests: [{ requestId: "req-5", status: "streaming", events: [] }],
    nextCursor: null, newerCursor: "after-2",
  });
  await f.conversationSession.openSession("session-1");
  f.realtime.handle({ type: "token", sessionId: "session-1", requestId: "req-5", text: "Live" });
  f.realtime.handle({ type: "event", name: "thinking.delta", sessionId: "session-1", requestId: "req-5", text: "Retained thinking" });
  return f;
}

test("newer history is inserted before the active tail and subsequent tokens keep the same row", async () => {
  const f = await fixture();
  f.client.loadSession.mockResolvedValueOnce({ messages: [raw(3), raw(4)], requests: [], nextCursor: "before-3", newerCursor: "after-4" });
  await f.conversationSession.history.load("newer");
  expect(f.state.messages.map((message) => message.id)).toEqual(["1", "2", "3", "4", "assistant-req-5"]);
  expect(f.state.activeRequestId).toBe("req-5");
  f.realtime.handle({ type: "token", sessionId: "session-1", requestId: "req-5", text: " tail" });
  expect(f.state.messages.at(-1)).toMatchObject({ text: "Live tail", thinkingText: "Retained thinking", streaming: true });
  expect(f.state.requestMessages.get("req-5")).toBe("assistant-req-5");
});

test.each(["completed", "chat_message"])("a %s racing the page is reconciled once using request identity", async (type) => {
  const f = await fixture();
  f.client.loadSession.mockResolvedValueOnce({ messages: [raw(3), raw(4)], requests: [], newerCursor: "after-4" });
  await f.conversationSession.history.load("newer");
  let finish!: (value: Record<string, unknown>) => void;
  f.client.loadSession.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const loading = f.conversationSession.history.load("newer");
  f.realtime.handle({ ...raw(5), type, sessionId: "session-1", output: "Answer 5" });
  finish({ messages: [raw(5)], requests: [{ requestId: "req-5", status: "completed", events: [] }], newerCursor: null });
  await loading;
  expect(f.state.messages.map((message) => message.id)).toEqual(["1", "2", "3", "4", "5"]);
  expect(f.state.messages.at(-1)).toMatchObject({ text: "Answer 5", thinkingText: "Retained thinking", persistedMessageId: 5, streaming: false });
  expect(f.state.requestMessages.get("req-5")).toBe("5");
  f.realtime.handle({ ...raw(5), type: "completed", sessionId: "session-1", output: "Answer 5" });
  f.realtime.handle({ ...raw(5), type: "chat_message", sessionId: "session-1" });
  expect(f.state.messages.map((message) => message.id)).toEqual(["1", "2", "3", "4", "5"]);
});

test("page reconciliation keeps approval rows and distinct persisted answers from the same request", () => {
  const approval = normalizeConversationMessage({ ...raw(1), kind: "tool_approval_request", requestId: "req-3" });
  const first = normalizeConversationMessage({ ...raw(2), requestId: "req-3" });
  const state = { messages: [approval, first], requestMessages: new Map([["req-3", "2"]]) };
  mergeHistoryPage(state, [normalizeConversationMessage(raw(3))], "newer", first);
  expect(state.messages.map((message) => message.id)).toEqual(["1", "2", "3"]);
  expect(state.messages[0]).toBe(approval);
  expect(state.requestMessages.get("req-3")).toBe("3");
});
