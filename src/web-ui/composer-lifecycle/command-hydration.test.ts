import { expect, test, vi } from "vitest";
import { createConversationSessionController } from "../app/controllers/conversation-session-controller.js";
import { createRealtimeContextHarness } from "../../runtime/__tests__/support/realtime-context-harness.js";
// @ts-expect-error Production browser module.
import { latestCommandRun } from "../app/lib/command-runs.js";

const started = {
  type: "event", name: "command.started", requestKind: "command",
  requestId: "command-1", sessionId: "session-1", environment: "environment-1",
  command: { name: "compact", mode: "run" }, seqNo: 1,
};
const request = { requestId: started.requestId, status: "streaming", events: [started] };

function fixture() {
  const f = createRealtimeContextHarness();
  const state = Object.assign(f.state, { sessions: [] });
  state.messages = [];
  state.requestMessages.clear();
  state.activeRequestId = "";
  const sessionQueue = { peek: vi.fn(() => null), refresh: vi.fn(async () => {}), rebindBlocked: vi.fn() };
  const client = {
    markSessionRead: vi.fn(async () => ({})), listSessions: vi.fn(async () => ({ sessions: [] })),
    loadSession: vi.fn(async () => ({ messages: [], requests: [request] })),
    fetchRequestEvents: vi.fn(async (): Promise<unknown[]> => []),
  };
  const sendRealtime = vi.fn(() => true);
  const session = createConversationSessionController({
    state, dom: { sessionTitle: { textContent: "" }, sessionsList: { innerHTML: "" } }, client,
    preferences: { sessionIdForEnvironment: () => "", saveSessionIdForEnvironment: vi.fn() },
    sessions: { titleOf: () => "Session", byId: vi.fn(), setCurrentTitle: vi.fn(), applyTitle: vi.fn(), applyReadState: vi.fn() },
    sessionQueue, conversationView: { reset: vi.fn() }, selectedEnvironmentId: () => "environment-1",
    applyConversationChrome: vi.fn(), applyModelSelection: vi.fn(), renderSessions: vi.fn(), renderMessages: vi.fn(),
    updateComposerSendState: vi.fn(), setMessageStatus: vi.fn(), sendRealtime,
    handleRealtimeMessage: f.controller.handle, recordEvent: f.controller.recordEvent,
    recordControlEvent: f.controller.recordControlEvent, reportQueueFailure: vi.fn(), drainQueuedMessage: vi.fn(),
    suspendQueueRecovery: () => true, recoverBlockedQueue: vi.fn(), isCurrentComposerScope: () => true, scheduleTask: vi.fn(),
  });
  return { ...f, session, sessionQueue, client, sendRealtime };
}

test.each(["completed", "failed"])("a %s command received during queue refresh overrides a stale streaming snapshot", async (type) => {
  const f = fixture();
  const terminal = { ...started, type, seqNo: 2, name: type === "completed" ? "context.compaction.completed" : "command.failed" };
  f.sessionQueue.refresh.mockImplementation(async () => { f.controller.handle(terminal); });
  await f.session.openSession("session-1");
  expect(f.state.activeRequestId).toBe("");
  expect(f.state.messages).toEqual([]);
  expect(f.state.requestMessages.size).toBe(0);
  expect(f.client.fetchRequestEvents).not.toHaveBeenCalled();
  expect(f.sendRealtime.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ type: "resume_request" }));
  expect(latestCommandRun(f.state, { environmentId: "environment-1", sessionId: "session-1" }).status).toBe(type);
});

test.each(["completed", "failed"])("a %s command received during event replay is not resumed afterward", async (type) => {
  const f = fixture();
  f.client.fetchRequestEvents.mockImplementation(async () => {
    f.controller.handle({ ...started, type, seqNo: 2, name: type === "completed" ? "context.compaction.completed" : "command.failed" });
    return [];
  });
  await f.session.rehydrateRequests([request]);
  expect(f.client.fetchRequestEvents).toHaveBeenCalledOnce();
  expect(f.state.activeRequestId).toBe("");
  expect(f.state.messages).toEqual([]);
  expect(f.state.requestMessages.size).toBe(0);
  expect(f.sendRealtime.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ type: "resume_request" }));
});

test("an unfinished command remains active and resumes without an assistant row", async () => {
  const f = fixture();
  await f.session.openSession("session-1");
  expect(f.state.activeRequestId).toBe("command-1");
  expect(f.state.messages).toEqual([]);
  expect(f.state.requestMessages.size).toBe(0);
  expect(f.sendRealtime.mock.calls.flat()).toContainEqual(expect.objectContaining({ type: "resume_request", requestId: "command-1" }));
});

test.each(["completed", "failed"])("a %s terminal replay settles the command without a second resume", async (type) => {
  const f = fixture();
  f.client.fetchRequestEvents.mockResolvedValue([{ ...started, type, seqNo: 2 }]);
  await f.session.openSession("session-1");
  expect(f.state.activeRequestId).toBe("");
  expect(f.state.messages).toEqual([]);
  expect(f.state.requestMessages.size).toBe(0);
  expect(f.sendRealtime.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ type: "resume_request" }));
});
