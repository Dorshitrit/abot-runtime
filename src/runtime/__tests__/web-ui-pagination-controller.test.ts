import { expect, test, vi } from "vitest";
// @ts-expect-error Browser controller.
import { createHistoryPagination } from "../../web-ui/app/controllers/history-pagination.js";
// @ts-expect-error Browser controller.
import { createSessionListPagination } from "../../web-ui/app/controllers/session-list-pagination.js";
// @ts-expect-error Browser projection.
import { mergeSparkSnapshotMessages } from "../../web-ui/app/controllers/spark-chat-sync.js";
import { normalizeConversationMessage } from "../../web-ui/app/controllers/conversation-session-controller.js";

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => { resolve = done; });
  return { resolve, promise };
}
const raw = (id: number) => ({ id, role: "assistant", text: String(id), createdAt: id, requestId: `req-${id}` });
function historyHarness() {
  let environmentId = "dev";
  const state = {
    currentSessionId: "long", sessionViewVersion: 1, messages: [normalizeConversationMessage(raw(3))],
    activeRequestId: "active", events: [{ requestId: "active" }],
  };
  const client = { loadSession: vi.fn() };
  const onRequests = vi.fn();
  const preserveScroll = vi.fn((change: () => void) => change());
  const history = createHistoryPagination({
    state, dom: {}, client, selectedEnvironmentId: () => environmentId, normalizeMessage: normalizeConversationMessage,
    onRequests, renderMessages: vi.fn(), conversationView: { preserveScroll }, applyReadState: vi.fn(),
  });
  history.adopt({ nextCursor: "older", requests: [{ requestId: "active" }] });
  return { state, client, history, onRequests, preserveScroll, switchEnvironment: () => { environmentId = "prod"; } };
}
test("older pages deduplicate messages/events and preserve active state and scroll", async () => {
  const h = historyHarness();
  const pending = deferred();
  h.client.loadSession.mockReturnValue(pending.promise);
  const loading = h.history.load();
  await h.history.load();
  expect(h.client.loadSession).toHaveBeenCalledTimes(1);
  pending.resolve({ messages: [raw(1), raw(2), raw(3)], requests: [{ requestId: "active" }, { requestId: "req-1", events: ["tool"] }], nextCursor: null });
  await loading;
  expect(h.state.messages.map((message) => message.id)).toEqual(["1", "2", "3"]);
  expect(h.state.events).toEqual([{ requestId: "active" }]);
  expect(h.state.activeRequestId).toBe("active");
  expect(h.onRequests).toHaveBeenCalledWith([{ requestId: "req-1", events: ["tool"] }]);
  expect(h.preserveScroll).toHaveBeenCalled();
  await h.history.load();
  expect(h.client.loadSession).toHaveBeenCalledTimes(1);
});
test.each(["environment", "reset"])("discards an in-flight history page after %s changes", async (change) => {
  const h = historyHarness();
  const pending = deferred(); h.client.loadSession.mockReturnValue(pending.promise);
  const loading = h.history.load();
  if (change === "environment") h.switchEnvironment();
  else h.history.reset();
  pending.resolve({ messages: [raw(1)], requests: [], nextCursor: null });
  await loading;
  expect(h.state.messages.map((message) => message.id)).toEqual(["3"]);
  expect(h.onRequests).not.toHaveBeenCalled();
});
test("SPARK refresh preserves loaded older pages and keeps a target window contiguous", () => {
  const current = [raw(1), raw(2), raw(3)].map(normalizeConversationMessage);
  const latest = { messages: [raw(3), raw(4)], requests: [], nextCursor: "older", newerCursor: null };
  expect(mergeSparkSnapshotMessages(latest, current).map((message: { id: string }) => message.id)).toEqual(["1", "2", "3", "4"]);
  expect(mergeSparkSnapshotMessages(latest, current, true).map((message: { id: string }) => message.id)).toEqual(["1", "2", "3"]);
});
test("session pages append, while changed search invalidates older responses", async () => {
  const state = { sessions: [] as Array<{ id: string }>, sessionQuery: "" };
  const client = { listSessions: vi.fn() };
  const paging = createSessionListPagination({ state, dom: { sessionsList: {} }, client, sessions: {}, selectedEnvironmentId: () => "dev", renderSessions: vi.fn(), onSessionListState: vi.fn() });
  client.listSessions.mockResolvedValueOnce({ sessions: [{ id: "a" }], nextCursor: "more" });
  await paging.load();
  client.listSessions.mockResolvedValueOnce({ sessions: [{ id: "b" }], nextCursor: null });
  await paging.load(true);
  expect(state.sessions.map((session) => session.id)).toEqual(["a", "b"]);
  const pending = deferred(); client.listSessions.mockReturnValueOnce(pending.promise);
  const oldSearch = paging.load();
  state.sessionQuery = "new";
  client.listSessions.mockResolvedValueOnce({ sessions: [{ id: "new" }], nextCursor: null });
  await paging.load();
  pending.resolve({ sessions: [{ id: "stale" }], nextCursor: "stale" });
  await oldSearch;
  expect(state.sessions.map((session) => session.id)).toEqual(["new"]);
});
