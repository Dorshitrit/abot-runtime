import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createSessionActivityController } from "../../web-ui/app/controllers/session-activity-controller.js";
// @ts-expect-error Browser-only module.
import { sessionActivityMarkup, updateSessionActivity } from "../../web-ui/app/components/session-activity.js";
// @ts-expect-error Browser transport composition module.
import { createAppRealtimeTransport } from "../../web-ui/app/app-realtime-transport.js";
// @ts-expect-error Browser-only module.
import { createSessionListPagination } from "../../web-ui/app/controllers/session-list-pagination.js";

const capture = vi.hoisted(() => ({ transport: null as any }));
vi.mock("../../web-ui/app/services/realtime-transport.js", () => ({
  createRealtimeTransport: (options: unknown) => {
    capture.transport = options;
    return { send: vi.fn(), connect: vi.fn() };
  },
}));

function detail(requestId = "request", sessionId = "background", environment = "dev") {
  return { requestId, sessionId, environment };
}

function lifecycle(status: string, revision: number, scope = detail()) {
  return { ...scope, type: "event", name: "request.lifecycle.changed", lifecycle: {
    ...scope, schemaVersion: 1, generation: "generation", status, revision,
  } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function fixture() {
  let environment = "dev";
  const state = { connected: true, currentSessionId: "foreground", activeRequestId: "foreground-request" };
  const client = { getSystemHealth: vi.fn(async (): Promise<any> => ({ activeStreamingRequestDetails: [] })) };
  const realtime = createAppRealtimeTransport({ state, getConfig: () => ({}), onMessage: vi.fn(),
    setConnectionLabel: vi.fn(), rejectPendingSteers: vi.fn(), recordControlEvent: vi.fn(), onConnected: vi.fn() });
  const onChange = vi.fn();
  const controller = createSessionActivityController({ client, getEnvironmentId: () => environment,
    onChange, realtime, isConnected: () => state.connected });
  return { controller, client, state, onChange, setEnvironment: (next: string) => { environment = next; },
    emit: (message: unknown) => capture.transport.onMessage(message) };
}

afterEach(() => vi.clearAllMocks());

test("initial health restores active background sessions only in the selected environment", async () => {
  const f = fixture();
  f.client.getSystemHealth.mockResolvedValue({ activeStreamingRequestDetails: [detail(), detail("other", "other", "prod")] });
  await f.controller.refresh();
  expect(f.controller.isWorking("background")).toBe(true);
  expect(f.controller.isWorking("foreground")).toBe(false);
  expect(f.controller.isWorking("other")).toBe(false);
  expect(f.state.currentSessionId).toBe("foreground");
  expect(f.state.activeRequestId).toBe("foreground-request");
});

test("global transport updates background work, pauses approval waits and resumes their continuation", () => {
  const f = fixture();
  f.emit(lifecycle("streaming", 1));
  expect(f.controller.isWorking("background")).toBe(true);
  f.emit(lifecycle("awaiting_approval", 2));
  expect(f.controller.isWorking("background")).toBe(false);
  f.emit(lifecycle("streaming", 1));
  expect(f.controller.isWorking("background")).toBe(false);
  f.emit(lifecycle("streaming", 3));
  expect(f.controller.isWorking("background")).toBe(true);
  f.emit({ ...detail(), type: "failed" });
  expect(f.controller.isWorking("background")).toBe(false);
  expect(f.state.currentSessionId).toBe("foreground");
});

test("one finished request does not hide another active request in the same session", () => {
  const f = fixture();
  f.emit(lifecycle("streaming", 1));
  f.emit(lifecycle("streaming", 1, detail("second")));
  f.emit({ ...detail(), type: "completed" });
  expect(f.controller.isWorking("background")).toBe(true);
  f.emit({ ...detail("second"), type: "completed" });
  expect(f.controller.isWorking("background")).toBe(false);
});

test("a persisted-message event reconciles initial work when no starting lifecycle was broadcast", async () => {
  const f = fixture();
  f.client.getSystemHealth.mockResolvedValue({ activeStreamingRequestDetails: [detail()] });
  f.emit({ ...detail(), type: "event", name: "session.messages.updated" });
  await vi.waitFor(() => expect(f.controller.isWorking("background")).toBe(true));
  expect(f.client.getSystemHealth).toHaveBeenCalledOnce();
  f.emit({ ...detail(), type: "event", name: "thinking.delta", text: "working" });
  expect(f.client.getSystemHealth).toHaveBeenCalledOnce();
});

test("a stale health response cannot resurrect completion or erase a newer running request", async () => {
  const f = fixture();
  const health = deferred<any>();
  f.client.getSystemHealth.mockReturnValueOnce(health.promise);
  const reading = f.controller.refresh();
  f.emit(lifecycle("streaming", 1));
  f.emit(lifecycle("completed", 2));
  f.emit(lifecycle("streaming", 1, detail("new", "new-session")));
  health.resolve({ activeStreamingRequestDetails: [detail()] });
  await reading;
  expect(f.controller.isWorking("background")).toBe(false);
  expect(f.controller.isWorking("new-session")).toBe(true);
});

test("wrong identities and stale environment reads never light another environment's session", async () => {
  const f = fixture();
  const health = deferred<any>();
  f.client.getSystemHealth.mockReturnValueOnce(health.promise);
  const reading = f.controller.refresh();
  f.setEnvironment("prod");
  f.emit(lifecycle("streaming", 1));
  const invalid = lifecycle("streaming", 1, detail("prod", "same", "prod"));
  invalid.lifecycle.sessionId = "different";
  f.emit(invalid);
  health.resolve({ activeStreamingRequestDetails: [detail("prod", "same", "prod")] });
  await reading;
  expect(f.controller.isWorking("same")).toBe(false);
  expect(f.controller.isWorking("background")).toBe(false);
});

test("disconnect clears stale work and reconnect restores the current active inventory", async () => {
  const f = fixture();
  f.emit(lifecycle("streaming", 1));
  capture.transport.onClose();
  expect(f.controller.isWorking("background")).toBe(false);
  f.client.getSystemHealth.mockResolvedValue({ activeStreamingRequestDetails: [detail()] });
  capture.transport.onOpen();
  await vi.waitFor(() => expect(f.controller.isWorking("background")).toBe(true));
});

test("a reconnect snapshot restores an approval continuation whose resume event was missed", async () => {
  const f = fixture();
  f.emit(lifecycle("streaming", 1));
  f.emit(lifecycle("awaiting_approval", 2));
  expect(f.controller.isWorking("background")).toBe(false);
  capture.transport.onClose();
  f.client.getSystemHealth.mockResolvedValue({ activeStreamingRequestDetails: [detail()] });
  capture.transport.onOpen();
  await vi.waitFor(() => expect(f.controller.isWorking("background")).toBe(true));
});

test("an approval wait stays paused while the server is releasing its active projection", async () => {
  const f = fixture();
  f.emit(lifecycle("awaiting_approval", 2));
  f.client.getSystemHealth.mockResolvedValue({ activeStreamingRequestDetails: [detail()] });
  await f.controller.refresh();
  expect(f.controller.isWorking("background")).toBe(false);
});

test("failed health reads remain recoverable without claiming inactive sessions are working", async () => {
  const f = fixture();
  f.client.getSystemHealth.mockRejectedValueOnce(new Error("offline"));
  await f.controller.refresh();
  expect(f.controller.isWorking("background")).toBe(false);
  f.client.getSystemHealth.mockResolvedValue({ activeStreamingRequestDetails: [detail()] });
  await f.controller.refresh();
  expect(f.controller.isWorking("background")).toBe(true);
});

test("indicators update in place, retain their accessible label, and escape session identity", () => {
  expect(sessionActivityMarkup('a"b', false)).toContain('data-session-id="a&quot;b"');
  expect(sessionActivityMarkup("active", true)).toContain('aria-label="ABot is working"');
  expect(sessionActivityMarkup("active", true)).not.toContain(" hidden");
  const indicators = [{ dataset: { sessionId: "active" }, hidden: true }, { dataset: { sessionId: "idle" }, hidden: true }];
  const root = { querySelectorAll: vi.fn(() => indicators), innerHTML: "unchanged row and menu" };
  updateSessionActivity(root, (id: string) => id === "active");
  expect(indicators.map((item) => item.hidden)).toEqual([false, true]);
  expect(root.innerHTML).toBe("unchanged row and menu");
  updateSessionActivity(root, () => false);
  expect(indicators.every((item) => item.hidden)).toBe(true);
});

test("activity refresh follows actual page reads without turning exhausted-list scrolling into health reads", async () => {
  const refreshActivity = vi.fn();
  const paging = createSessionListPagination({ state: { sessions: [], sessionQuery: "" }, dom: {},
    client: { listSessions: async () => ({ sessions: [], nextCursor: null }) }, sessions: { refreshActivity },
    selectedEnvironmentId: () => "dev", renderSessions: vi.fn(), onSessionListState: vi.fn() });
  await paging.load();
  expect(refreshActivity).toHaveBeenCalledOnce();
  await paging.load(true);
  await paging.load(true);
  expect(refreshActivity).toHaveBeenCalledOnce();
});
