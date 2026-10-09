import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser composition module.
import { createSparkChatFeature } from "../../web-ui/app/spark-chat-feature.js";

const capture = vi.hoisted(() => ({ conversation: null as any, panelDom: null as any, setOpen: vi.fn(), resetView: vi.fn(), render: vi.fn() }));
vi.mock("../../web-ui/app/spark-chat-conversation.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, (...args: any[]) => any>>();
  return { createSparkChatConversation: (...args: any[]) => (capture.conversation = actual.createSparkChatConversation(...args)) };
});
vi.mock("../../web-ui/app/controllers/conversation-view-feature.js", () => ({
  createConversationViewFeature: () => new Proxy({ reset: capture.resetView, render: capture.render, preserveScroll: (render: () => void) => render() }, {
    get: (target, key) => Reflect.get(target, key) ?? vi.fn(),
  }),
}));
vi.mock("../../web-ui/app/components/spark-chat/settings.js", () => ({ createSparkChatSettings: () => ({ render: vi.fn() }) }));
vi.mock("../../web-ui/app/components/spark-chat/panel.js", () => ({
  createSparkChatPanel: () => ({ dom: capture.panelDom, isOpen: () => false, setOpen: capture.setOpen, setAvailable: vi.fn(),
    onToggle: vi.fn(), showNotice: vi.fn(), hideNotice: vi.fn(), setUnread: vi.fn(), resetPosition: vi.fn() }),
}));

class ElementStub extends EventTarget {
  value = ""; textContent = ""; innerHTML = ""; style = {}; dataset = {}; disabled = false; hidden = false;
  classList = { toggle: vi.fn(), add: vi.fn(), remove: vi.fn() };
  setAttribute = vi.fn(); focus = vi.fn(); closest = () => null; querySelector = () => null;
  appendChild = vi.fn(); querySelectorAll = () => []; scrollHeight = 32;
}
function domStub() {
  const nodes = new Map<PropertyKey, ElementStub>();
  return new Proxy({} as Record<string, ElementStub>, { get: (_target, key) => {
    if (!nodes.has(key)) nodes.set(key, new ElementStub());
    return nodes.get(key);
  } });
}
const message = (id: number) => ({ id, role: "assistant", text: `Answer ${id}`, requestId: `req-${id}`, createdAt: id });
const latest = { sessionId: "spark-companion", kind: "spark", messages: [message(21), message(22)], requests: [] as Record<string, unknown>[], nextCursor: "older", newerCursor: null };
const target = { ...latest, messages: [message(1), message(2)], nextCursor: null, newerCursor: "newer" };

async function fixture(unread: boolean) {
  vi.stubGlobal("document", Object.assign(new ElementStub(), { createElement: () => new ElementStub() }));
  vi.stubGlobal("window", Object.assign(new ElementStub(), { setTimeout, requestAnimationFrame: vi.fn() }));
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  const dom = domStub(); dom.environmentSelect.value = "dev";
  capture.panelDom = domStub();
  const result = { sessionId: "spark-companion", modelProfileId: "model", snapshot: latest,
    readState: { readGeneration: "same", unreadMessageIds: unread ? [1] : [], unreadCount: unread ? 1 : 0 } };
  const client = {
    supportsSparkChat: () => true, listModels: async () => ({ profiles: [{ id: "model" }] }),
    loadSparkChat: vi.fn(async () => result),
    loadSession: vi.fn<(...args: any[]) => Promise<Record<string, unknown>>>(async () => latest),
    fetchRequestEvents: vi.fn(async (): Promise<Record<string, unknown>[]> => []), markSessionRead: vi.fn(),
  };
  const shell = { isWorkspaceAvailable: () => true, subscribeRuntimeAvailabilityChange: vi.fn(), showToast: vi.fn(), subscribeWorkspaceChange: vi.fn() };
  const subscribeConnected = vi.fn();
  const send = vi.fn(() => true);
  const feature = createSparkChatFeature({ dom, state: { connected: true, runtimeAvailability: { status: "ready" } }, client, shell,
    realtime: { subscribeMessages: vi.fn(), subscribeConnected, send }, getEnvironmentId: () => dom.environmentSelect.value });
  feature.bind();
  feature.environmentChanged();
  await vi.waitFor(() => expect(capture.conversation.state.messages).toHaveLength(2));
  const conversation = capture.conversation;
  const open = () => unread ? feature.open() : feature.openSession("spark-companion", 1, { createdAt: 1, requestId: "req-1" });
  const reconnect = async () => {
    capture.render.mockClear();
    subscribeConnected.mock.calls[0]![0]();
    await vi.waitFor(() => expect(capture.render).toHaveBeenCalled());
  };
  return { client, shell, feature, conversation, open, result, reconnect, send };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

test.each([
  [false, "network_error"], [false, "history_cursor_stale"],
  [true, "network_error"], [true, "history_cursor_stale"],
] as const)("SPARK target failure preserves the loaded view and permits retry (unread: %s, error: %s)", async (unread, code) => {
  const f = await fixture(unread);
  const beforeVersion = f.conversation.state.sessionViewVersion;
  const events = f.conversation.state.events;
  events.push({ name: "retained event" });
  let finish!: (value: Record<string, unknown>) => void;
  let reject!: (error: Error) => void;
  f.client.loadSession.mockReturnValueOnce(new Promise((resolve, fail) => { finish = resolve; reject = fail; }));
  const opening = f.open();
  await vi.waitFor(() => expect(f.client.loadSession).toHaveBeenCalledOnce());
  expect(f.conversation.state.messages.map((entry: any) => entry.id)).toEqual(["21", "22"]);
  expect(f.conversation.state.sessionViewVersion).toBe(beforeVersion);
  reject(Object.assign(new Error(code), { code }));
  expect(await opening).toBe(false);
  expect(f.conversation.state.messages.map((entry: any) => entry.id)).toEqual(["21", "22"]);
  expect(f.conversation.state.events).toBe(events);
  expect(f.conversation.state.events).toContainEqual({ name: "retained event" });
  expect(f.conversation.state.sessionViewVersion).toBe(beforeVersion);
  expect(f.shell.showToast).toHaveBeenCalledWith(expect.stringContaining("SPARK history unavailable"), "failed");
  expect(capture.setOpen).not.toHaveBeenCalled();
  f.client.loadSession.mockResolvedValueOnce({ ...latest, messages: [message(20)] });
  await f.conversation.session.history.load("older");
  expect(f.client.loadSession).toHaveBeenLastCalledWith("spark-companion", "dev", { cursor: "older" });
  expect(f.conversation.state.messages.map((entry: any) => entry.id)).toEqual(["20", "21", "22"]);
  f.client.loadSession.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const retrying = f.open();
  await vi.waitFor(() => expect(f.client.loadSession).toHaveBeenCalledTimes(3));
  expect(f.conversation.state.messages.map((entry: any) => entry.id)).toEqual(["20", "21", "22"]);
  finish(target);
  expect(await retrying).toBe(true);
  expect(f.conversation.state.messages.map((entry: any) => entry.id)).toEqual(["1", "2"]);
  expect(f.conversation.session.history.hasNewer()).toBe(true);
  expect(capture.setOpen).toHaveBeenCalledExactlyOnceWith(true);
  expect(f.client.markSessionRead).not.toHaveBeenCalled();
});

test.each(["idle", "streaming", "awaiting_approval"])("SPARK reconnect retains the target window while hydrating %s work", async (status) => {
  const f = await fixture(false);
  f.client.loadSession.mockResolvedValueOnce({ ...target, nextCursor: "target-older" });
  await f.open();
  const version = f.conversation.state.sessionViewVersion;
  f.conversation.state.events.push({ name: "retained target event" });
  if (status !== "idle") f.result.snapshot = { ...latest, requests: [{ requestId: "req-23", status,
    lifecycle: { schemaVersion: 1, requestId: "req-23", generation: "one", revision: 1, status }, events: [] }] };
  capture.resetView.mockClear();
  await f.reconnect();
  expect(f.conversation.state.messages.slice(0, 2).map((entry: any) => entry.id)).toEqual(["1", "2"]);
  expect(f.conversation.state.messages.some((entry: any) => entry.id === "22")).toBe(false);
  expect(f.conversation.state.events).toContainEqual({ name: "retained target event" });
  expect(f.conversation.state.sessionViewVersion).toBe(version);
  expect(capture.resetView).not.toHaveBeenCalled();
  expect(f.conversation.session.history.hasNewer()).toBe(true);
  if (status !== "idle") expect(f.conversation.state.requestLifecycles.get("req-23").status).toBe(status);
  if (status === "streaming") {
    expect(f.conversation.state.activeRequestId).toBe("req-23");
    expect(f.client.fetchRequestEvents).toHaveBeenCalledWith({ requestId: "req-23", afterSeq: 0, environmentId: "dev" });
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: "resume_request", requestId: "req-23" }));
  }
  f.client.loadSession.mockResolvedValueOnce({ messages: [message(0)], requests: [], nextCursor: null });
  await f.conversation.session.history.load("older");
  expect(f.client.loadSession).toHaveBeenLastCalledWith("spark-companion", "dev", { cursor: "target-older" });
  f.client.loadSession.mockResolvedValueOnce({ messages: [message(3)], requests: [], newerCursor: "after-3" });
  await f.conversation.session.history.load("newer");
  expect(f.client.loadSession).toHaveBeenLastCalledWith("spark-companion", "dev", { cursor: "newer" });
  expect(f.conversation.state.messages.slice(0, 4).map((entry: any) => entry.id)).toEqual(["0", "1", "2", "3"]);
  expect(f.client.markSessionRead).not.toHaveBeenCalled();
});

test("SPARK reconnect reconciles a completed live tail without replacing its older target", async () => {
  const f = await fixture(false);
  f.client.loadSession.mockResolvedValueOnce({ ...target, requests: [{ requestId: "req-23", status: "streaming", events: [] }] });
  await f.open();
  f.result.snapshot = { ...latest, messages: [...latest.messages, message(23)], requests: [{ requestId: "req-23", status: "completed" }] };
  await f.reconnect();
  expect(f.conversation.state.messages.map((entry: any) => entry.id)).toEqual(["1", "2", "23"]);
  expect(f.conversation.state.messages.at(-1).streaming).toBe(false);
  expect(f.conversation.state.requestMessages.get("req-23")).toBe("23");
  expect(f.conversation.state.activeRequestId).toBe("");
  expect(f.conversation.session.history.hasNewer()).toBe(true);
});

test("a real SPARK history reset still discards the old target and cursors on reconnect", async () => {
  const f = await fixture(false);
  f.client.loadSession.mockResolvedValueOnce(target);
  await f.open();
  f.result.readState.readGeneration = "after-reset";
  f.result.snapshot = { ...latest, messages: [message(1)] };
  capture.resetView.mockClear();
  await f.reconnect();
  expect(f.conversation.state.messages.map((entry: any) => entry.id)).toEqual(["1"]);
  expect(f.conversation.session.history.hasNewer()).toBe(false);
  expect(capture.resetView).toHaveBeenCalled();
});

test("repeated SPARK reconnects resume after received tokens without duplicating the live tail", async () => {
  const f = await fixture(false);
  const request = { requestId: "req-23", status: "streaming", events: [] as Record<string, unknown>[] };
  f.client.loadSession.mockResolvedValueOnce({ ...target, requests: [request] });
  await f.open();
  f.conversation.handleRealtime({ type: "token", sessionId: "spark-companion", requestId: "req-23", seqNo: 10, text: "Live text" });
  request.events.push({ type: "token", requestId: "req-23", seqNo: 10, text: "Live text" });
  f.result.snapshot = { ...latest, requests: [request] };
  f.client.fetchRequestEvents.mockClear();
  f.client.fetchRequestEvents.mockResolvedValueOnce([{ type: "token", requestId: "req-23", seqNo: 11, text: " resumed" }]);
  await f.reconnect();
  await f.reconnect();
  expect(f.conversation.state.messages.map((entry: any) => entry.id)).toEqual(["1", "2", "assistant-req-23"]);
  expect(f.conversation.state.messages.at(-1).text).toBe("Live text resumed");
  expect(f.client.fetchRequestEvents).toHaveBeenCalledTimes(2);
  expect(f.client.fetchRequestEvents).toHaveBeenNthCalledWith(1, { requestId: "req-23", afterSeq: 10, environmentId: "dev" });
  expect(f.client.fetchRequestEvents).toHaveBeenNthCalledWith(2, { requestId: "req-23", afterSeq: 11, environmentId: "dev" });
});
