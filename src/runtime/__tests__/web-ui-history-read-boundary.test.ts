import { expect, test, vi } from "vitest";
import { createConversationSessionController, normalizeConversationMessage } from "../../web-ui/app/controllers/conversation-session-controller.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const message = (id: number) => ({ id, role: "assistant", text: `Answer ${id}`, requestId: `req-${id}` });
function fixture(visible = true) {
  const { state } = createPlanLifecycleHarness();
  const client = {
    loadSession: vi.fn(async (): Promise<Record<string, unknown>> => ({ messages: [message(2), message(3)], requests: [], nextCursor: "older", newerCursor: "newer", readState: { unreadCount: 7 } })),
    listSessions: vi.fn(async () => ({})), fetchRequestEvents: vi.fn(async () => []),
    markSessionRead: vi.fn(async ({ readThroughMessageId }: { readThroughMessageId: string | number | null }) => ({ readState: { unreadCount: 10 - Number(readThroughMessageId) } })),
  };
  const applyReadState = vi.fn();
  const sessionQueue = { peek: vi.fn<() => { waitForRequestId: string } | null>(() => null), rebindBlocked() {} };
  const drainQueuedMessage = vi.fn(async () => {});
  const controller = createConversationSessionController({
    state, client, dom: { sessionTitle: { textContent: "" }, sessionsList: { innerHTML: "" } },
    preferences: { sessionIdForEnvironment: () => "", saveSessionIdForEnvironment() {} },
    sessions: { byId: () => ({}), titleOf: () => "", setCurrentTitle() {}, applyTitle() {}, applyReadState },
    sessionQueue, conversationView: { reset() {} },
    selectedEnvironmentId: () => "dev", isConversationVisible: () => visible, scheduleTask: (callback) => callback(),
    clearPendingAttachments() {}, applyConversationChrome() {}, applyModelSelection() {}, renderSessions() {}, renderMessages() {},
    updateComposerSendState() {}, setMessageStatus() {}, sendRealtime() {}, handleRealtimeMessage() {}, recordEvent() {}, recordControlEvent() {},
    reportQueueFailure() {}, drainQueuedMessage, suspendQueueRecovery: () => true, recoverBlockedQueue() {}, isCurrentComposerScope: () => true,
  });
  return { state, client, controller, applyReadState, sessionQueue, drainQueuedMessage };
}

test("loading newer history advances read-through to the displayed boundary exactly once", async () => {
  const f = fixture();
  await f.controller.openSession("session-1");
  expect(f.client.markSessionRead).toHaveBeenLastCalledWith({ sessionId: "session-1", environmentId: "dev", readThroughMessageId: 3 });
  f.client.markSessionRead.mockClear();
  f.client.loadSession.mockResolvedValueOnce({ messages: [message(4), message(5)], requests: [], nextCursor: "older", newerCursor: "next", readState: { unreadCount: 7 } });
  await f.controller.history.load("newer");
  expect(f.client.markSessionRead).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1", environmentId: "dev", readThroughMessageId: 5 });
  expect(f.applyReadState).toHaveBeenLastCalledWith("session-1", { unreadCount: 5 });
  f.client.loadSession.mockResolvedValueOnce({ messages: [message(1)], requests: [], nextCursor: "", newerCursor: "next", readState: { unreadCount: 5 } });
  await f.controller.history.load("older");
  expect(f.client.markSessionRead).toHaveBeenCalledOnce();
});

test.each(["hidden", "failed", "stale"])("%s newer pages do not mark the conversation read", async (mode) => {
  const f = fixture(mode !== "hidden");
  await f.controller.openSession("session-1");
  f.client.markSessionRead.mockClear();
  f.client.loadSession.mockImplementationOnce(async () => {
    if (mode === "failed") throw new Error("network unavailable");
    if (mode === "stale") f.state.sessionViewVersion++;
    return { messages: [message(4)], requests: [], nextCursor: "", newerCursor: "", readState: { unreadCount: 7 } };
  });
  await f.controller.history.load("newer");
  expect(f.client.markSessionRead).not.toHaveBeenCalled();
});

test.each([true, false])("newer history marks only its own boundary before a live tail (streaming: %s)", async (streaming) => {
  const f = fixture();
  await f.controller.openSession("session-1");
  const tail = { ...normalizeConversationMessage(message(10)), streaming };
  f.state.messages.push(tail);
  f.client.markSessionRead.mockClear();
  f.client.loadSession.mockResolvedValueOnce({ messages: [message(4), message(5)], requests: [], nextCursor: "older", newerCursor: "next", readState: { unreadCount: 7 } });
  await f.controller.history.load("newer");
  expect(f.state.messages.map((entry) => entry.id)).toEqual(["2", "3", "4", "5", "10"]);
  expect(f.state.messages.at(-1)).toBe(tail);
  expect(f.client.markSessionRead).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1", environmentId: "dev", readThroughMessageId: 5 });
});

test.each([true, false])("opening a target page marks its completed boundary before restoring a live request (visible: %s)", async (visible) => {
  const f = fixture(visible);
  f.client.loadSession.mockResolvedValueOnce({ messages: [message(2), message(3)], requests: [{ requestId: "req-10", status: "streaming" }], newerCursor: "newer" });
  await f.controller.openSession("session-1", { page: { targetRequestId: "req-2" } });
  expect(f.state.messages.map((entry) => entry.id)).toEqual(["2", "3", "assistant-req-10"]);
  expect(f.state.messages.at(-1)?.streaming).toBe(true);
  expect(f.state.activeRequestId).toBe("req-10");
  if (!visible) { expect(f.client.markSessionRead).not.toHaveBeenCalled(); return; }
  expect(f.client.markSessionRead).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1", environmentId: "dev", readThroughMessageId: 3 });
});

test.each([true, false])("request-only rehydration preserves Send next recovery without replacing history (dependency present: %s)", async (included) => {
  const f = fixture();
  await f.controller.openSession("session-1");
  const messages = f.state.messages;
  const version = f.state.sessionViewVersion;
  f.sessionQueue.peek.mockReturnValue({ waitForRequestId: "req-9" });
  f.client.loadSession.mockClear();
  const dependency = { requestId: "req-9", status: "completed" };
  f.client.loadSession.mockResolvedValueOnce({ messages: [message(99)], requests: [dependency] });
  expect(await f.controller.rehydrateRequests(included ? [dependency] : [])).toBe(true);
  expect(f.state.messages).toBe(messages);
  expect(f.state.sessionViewVersion).toBe(version);
  expect(f.controller.history.hasNewer()).toBe(true);
  expect(f.drainQueuedMessage).toHaveBeenCalledExactlyOnceWith({ environmentId: "dev", sessionId: "session-1", terminalRequestId: "req-9", cancelled: false });
  if (included) { expect(f.client.loadSession).not.toHaveBeenCalled(); return; }
  expect(f.client.loadSession).toHaveBeenCalledExactlyOnceWith("session-1", "dev", { waitingRequestId: "req-9" });
});
