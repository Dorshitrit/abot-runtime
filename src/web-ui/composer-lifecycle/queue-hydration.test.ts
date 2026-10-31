import { describe, expect, test, vi } from "vitest";
import {
  createConversationSessionController,
  type ConversationSessionState,
} from "../app/controllers/conversation-session-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const scope = { environmentId: "prod", sessionId: "chat" };
const request = (requestId: string, status = "completed") => ({
  requestId, status, events: [{ type: "event", name: `saved-${requestId}`, requestId, seqNo: 1 }],
});
const page = (requests: Record<string, unknown>[] = [request("historical")]) => ({
  messages: [{ id: "visible", role: "assistant", text: "Historical answer", requestId: "historical" }],
  requests, nextCursor: "original-older", newerCursor: "original-newer",
});

function fixture(inputRequests?: Record<string, unknown>[]) {
  let environmentId = scope.environmentId;
  let visibleHead: { waitForRequestId: string } | null = null;
  let remoteHead: { waitForRequestId: string } | null = { waitForRequestId: "waiting" };
  const state: ConversationSessionState = {
    currentSessionId: "", activeRequestId: "", sessionViewVersion: 0, messages: [], events: [], sessions: [],
    taskProgressByRequest: new Map(), contextWindowByRequest: new Map(), submittedToolApprovalIds: new Set(),
    requestMessages: new Map(), lastSeqByRequest: new Map(),
  };
  const fresh = { messages: [{ id: "latest", role: "assistant", text: "Latest answer" }], requests: [request("waiting")] };
  const client = {
    loadSession: vi.fn(async (_session: string, _environment: string, _options?: Record<string, unknown>): Promise<Record<string, unknown>> => fresh)
      .mockResolvedValueOnce(page(inputRequests)),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    fetchRequestEvents: vi.fn(async () => []), markSessionRead: vi.fn(async () => ({})),
  };
  const sessionQueue = {
    peek: vi.fn(() => visibleHead),
    refresh: vi.fn(async () => { visibleHead = remoteHead; }),
    rebindBlocked: vi.fn(),
  };
  const drainQueuedMessage = vi.fn(async () => {});
  const sendRealtime = vi.fn();
  const recordEvent = vi.fn();
  const controller = createConversationSessionController({
    state, client, sessionQueue, selectedEnvironmentId: () => environmentId,
    dom: { sessionTitle: { textContent: "" }, sessionsList: { innerHTML: "" } },
    preferences: { sessionIdForEnvironment: () => "", saveSessionIdForEnvironment() {} },
    sessions: { byId: () => ({}), titleOf: () => "", setCurrentTitle() {}, applyTitle() {}, applyReadState() {} },
    conversationView: { reset() {} },
    applyConversationChrome() {}, applyModelSelection() {}, renderSessions() {}, renderMessages() {},
    updateComposerSendState() {}, setMessageStatus() {}, sendRealtime, handleRealtimeMessage() {},
    recordEvent, recordControlEvent() {}, reportQueueFailure() {}, drainQueuedMessage,
    suspendQueueRecovery: () => true, recoverBlockedQueue() {}, isCurrentComposerScope: () => true,
    scheduleTask() {},
  });
  return { controller, state, client, sessionQueue, drainQueuedMessage, sendRealtime, recordEvent,
    setEnvironment: (value: string) => { environmentId = value; },
    setRemoteHead: (value: typeof remoteHead) => { remoteHead = value; },
  };
}

test("queue refresh discovers a terminal outside the loaded history and drains it once without replacing that page", async () => {
  const f = fixture();
  await f.controller.openSession(scope.sessionId, { page: { targetRequestId: "historical" } });
  expect(f.client.loadSession.mock.calls).toEqual([
    ["chat", "prod", { targetRequestId: "historical", waitingRequestId: undefined }],
    ["chat", "prod", { waitingRequestId: "waiting" }],
  ]);
  expect(f.drainQueuedMessage).toHaveBeenCalledExactlyOnceWith({ ...scope, terminalRequestId: "waiting", cancelled: false });
  expect(f.state.messages.map((message) => message.id)).toEqual(["visible"]);
  expect(f.controller.history.hasNewer()).toBe(true);
  expect(f.recordEvent.mock.calls.map(([event]) => event.name)).toEqual(["saved-historical", "saved-waiting"]);
  f.client.loadSession.mockResolvedValueOnce({ messages: [], requests: [] });
  await f.controller.history.load("newer");
  expect(f.client.loadSession).toHaveBeenLastCalledWith("chat", "prod", { cursor: "original-newer" });
});

test("a newly discovered streaming dependency is resumed instead of releasing its queued follow-up", async () => {
  const f = fixture();
  f.client.loadSession.mockResolvedValueOnce({ requests: [request("waiting", "streaming")] });
  await f.controller.openSession(scope.sessionId);
  expect(f.state.activeRequestId).toBe("waiting");
  expect(f.sendRealtime).toHaveBeenCalledWith({ type: "subscribe_request", requestId: "waiting" });
  expect(f.sendRealtime).toHaveBeenCalledWith({ type: "resume_request", requestId: "waiting", sessionId: "chat", afterSeq: 0, environment: "prod" });
  expect(f.client.fetchRequestEvents).toHaveBeenCalledExactlyOnceWith({ requestId: "waiting", sessionId: "chat", afterSeq: 0, environmentId: "prod" });
  expect(f.drainQueuedMessage).not.toHaveBeenCalled();
  expect(f.state.messages[0]?.id).toBe("visible");
});

test("a dependency already in the supplied page needs no extra fetch after refresh", async () => {
  const f = fixture([request("historical"), request("waiting")]);
  await f.controller.openSession(scope.sessionId);
  expect(f.client.loadSession).toHaveBeenCalledOnce();
  expect(f.drainQueuedMessage).toHaveBeenCalledExactlyOnceWith({ ...scope, terminalRequestId: "waiting", cancelled: false });
});

test("no queued dependency adds no history request", async () => {
  const f = fixture();
  f.setRemoteHead(null);
  await f.controller.openSession(scope.sessionId);
  expect(f.client.loadSession).toHaveBeenCalledOnce();
  expect(f.drainQueuedMessage).not.toHaveBeenCalled();
});

describe.each(["environment", "view"])("navigation during metadata fetch: %s", (kind) => {
  test("does not hydrate or release requests in the replacement view", async () => {
    const f = fixture();
    const pending = deferred<Record<string, unknown>>();
    const fetching = deferred<void>();
    f.client.loadSession.mockImplementationOnce(async () => { fetching.resolve(); return pending.promise; });
    const opening = f.controller.openSession(scope.sessionId);
    await fetching.promise;
    if (kind === "environment") f.setEnvironment("dev");
    else { f.state.currentSessionId = "other"; f.state.sessionViewVersion += 1; }
    f.state.messages = [{ id: "new-view", role: "assistant", text: "Other view", requestId: "other" }];
    const messages = f.state.messages;
    f.sendRealtime.mockClear();
    pending.resolve({ requests: [request("waiting", "streaming")] });
    await opening;
    expect(f.state.messages).toBe(messages);
    expect(f.state.activeRequestId).toBe("");
    expect(f.sendRealtime).not.toHaveBeenCalled();
    expect(f.recordEvent).not.toHaveBeenCalled();
    expect(f.drainQueuedMessage).not.toHaveBeenCalled();
    expect(f.client.loadSession).toHaveBeenLastCalledWith("chat", "prod", { waitingRequestId: "waiting" });
  });
});

test("fresh request status replaces stale streaming metadata and absent old active requests cannot revive", async () => {
  const f = fixture([request("historical"), request("finished", "streaming"), request("absent", "streaming")]);
  f.client.loadSession.mockResolvedValueOnce({ requests: [request("waiting"), request("finished")] });
  await f.controller.openSession(scope.sessionId);
  expect(f.state.activeRequestId).toBe("");
  expect(f.client.fetchRequestEvents).not.toHaveBeenCalled();
  expect(f.sendRealtime.mock.calls.some(([event]) => event.type === "subscribe_request")).toBe(false);
  expect(f.recordEvent.mock.calls.map(([event]) => event.name)).toEqual(["saved-historical", "saved-waiting", "saved-finished"]);
  expect(f.drainQueuedMessage).toHaveBeenCalledOnce();
});

test("request-only rehydration checks the dependency after refresh, using the same completeness path", async () => {
  const f = fixture();
  f.setRemoteHead(null);
  await f.controller.openSession(scope.sessionId);
  const messages = f.state.messages;
  f.client.loadSession.mockClear();
  f.setRemoteHead({ waitForRequestId: "waiting" });
  await f.controller.rehydrateRequests([request("historical")]);
  expect(f.client.loadSession).toHaveBeenCalledExactlyOnceWith("chat", "prod", { waitingRequestId: "waiting" });
  expect(f.state.messages).toBe(messages);
  expect(f.controller.history.hasNewer()).toBe(true);
  expect(f.drainQueuedMessage).toHaveBeenCalledOnce();
});

test("a refetched snapshot still missing the dependency is not fetched repeatedly or released", async () => {
  const f = fixture();
  f.client.loadSession.mockResolvedValueOnce({ requests: [] });
  await f.controller.openSession(scope.sessionId);
  expect(f.client.loadSession).toHaveBeenCalledTimes(2);
  expect(f.drainQueuedMessage).not.toHaveBeenCalled();
  expect(f.state.messages.map((message) => message.id)).toEqual(["visible"]);
});
