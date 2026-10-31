import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser composition module.
import { createSparkChatFeature } from "../../web-ui/app/spark-chat-feature.js";

// @ts-expect-error Browser composition module.
import { createNotificationsFeature } from "../../web-ui/app/notifications-feature.js";

const capture = vi.hoisted(() => ({ panel: null as any, conversation: null as any, notificationActions: null as any }));
vi.mock("../../web-ui/app/components/notifications/dom.js", () => ({ mountNotificationsDom: vi.fn() }));
vi.mock("../../web-ui/app/components/notifications/home-entry.js", () => ({
  createHomeNotificationsEntry: () => ({ render: vi.fn() }),
}));
vi.mock("../../web-ui/app/components/notifications/workspace.js", () => ({
  createNotificationsWorkspace: ({ actions }: any) => {
    capture.notificationActions = actions;
    return { render: vi.fn() };
  },
}));
vi.mock("../../web-ui/app/components/spark-chat/panel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, (...args: any[]) => any>>();
  return { createSparkChatPanel: (...args: any[]) => (capture.panel = actual.createSparkChatPanel(...args)) };
});
vi.mock("../../web-ui/app/components/spark-chat/placement.js", () => ({
  createSparkChatPlacement: () => ({ refresh: vi.fn(), reset: vi.fn() }),
}));
vi.mock("../../web-ui/app/components/spark-chat/settings.js", () => ({
  createSparkChatSettings: () => ({ render: vi.fn() }),
}));
vi.mock("../../web-ui/app/spark-chat-conversation.js", () => ({
  createSparkChatConversation: () => capture.conversation,
}));

class ElementStub extends EventTarget {
  hidden = false; className = ""; innerHTML = ""; textContent = ""; value = "prod"; isConnected = true;
  dataset: Record<string, string> = {};
  parentElement: ElementStub | null = null;
  attributes = new Map<string, string>();
  constructor(readonly ownerDocument: any) { super(); }
  append(node: ElementStub) { node.parentElement = this; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  focus() { this.ownerDocument.activeElement = this; }
  insertAdjacentHTML = vi.fn();
  closest = () => null;
  querySelectorAll = (_selector: string): ElementStub[] => [];
  querySelector = (_selector: string): ElementStub | null => null;
}

function createPanelDocument() {
  const documentRoot: any = Object.assign(new EventTarget(), { activeElement: null, visibilityState: "visible" });
  documentRoot.body = new ElementStub(documentRoot);
  documentRoot.hasFocus = () => true;
  const panel = new ElementStub(documentRoot), notice = new ElementStub(documentRoot);
  panel.hidden = true; notice.hidden = true;
  const names = ["settingsButton", "launcherButton", "messagesList", "composerInput", "composerForm", "closeButton", "mascotButton",
    "noticeButton", "dismissNoticeButton", "sendNextMenu", "unreadBadge"];
  const nodes = Object.fromEntries(names.map((name) => {
    const node = new ElementStub(documentRoot); node.dataset.spark = name;
    return [name, node];
  }));
  nodes.composerForm!.parentElement = panel;
  nodes.sendNextMenu!.hidden = true;
  documentRoot.createElement = (tag: string) => {
    const node = new ElementStub(documentRoot);
    if (tag !== "aside") return node;
    node.querySelectorAll = () => Object.values(nodes);
    node.querySelector = (selector) => selector === ".spark-chat-panel" ? panel : notice;
    return node;
  };
  return documentRoot;
}

async function fixture(initialSnapshot?: Promise<any>) {
  const documentRoot = createPanelDocument();
  vi.stubGlobal("document", documentRoot);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { requestAnimationFrame: vi.fn() }));
  const state = {
    messages: [] as any[], currentSessionId: "", composerSending: false, activeRequestId: "",
    requestMessages: new Map(), requestLifecycles: new Map(),
  };
  const conversation = {
    state, render: vi.fn(), update: vi.fn(), status: vi.fn(), reset: vi.fn(),
    attachments: { removeUnsupportedImages: vi.fn() }, view: { closeFilePreview: vi.fn() },
    session: { openSession: vi.fn(async (sessionId: string, options: any) => {
      state.currentSessionId = sessionId;
      state.messages = options.snapshot?.messages ?? [];
      return true;
    }) },
  };
  capture.conversation = conversation;
  const result = { sessionId: "spark", modelProfileId: "model", snapshot: { messages: [], requests: [] },
    readState: { unreadMessageIds: [] as number[], unreadCount: 0, readGeneration: "one" } };
  const client = { supportsSparkChat: () => true, loadSparkChat: vi.fn(async () => result),
    listModels: vi.fn(async () => ({ profiles: [{ id: "model" }] })) };
  if (initialSnapshot) client.loadSparkChat.mockReturnValueOnce(initialSnapshot);
  const shell = { isWorkspaceAvailable: () => true, showToast: vi.fn() };
  const feature = createSparkChatFeature({
    dom: { environmentSelect: new ElementStub(documentRoot), learningRoot: new ElementStub(documentRoot) },
    state: { connected: true, runtimeAvailability: { status: "ready" } }, client, shell,
    realtime: { send: vi.fn() }, getEnvironmentId: () => "prod",
  });
  feature.environmentChanged();
  if (!initialSnapshot) await vi.waitFor(() => expect(state.currentSessionId).toBe("spark"));
  conversation.session.openSession.mockClear();
  const outside = new ElementStub(documentRoot);
  outside.focus();
  return { feature, panel: capture.panel, client, shell, conversation, result, documentRoot, outside };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail; });
  return { promise, resolve, reject };
}

const finishBrowserTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function launch(f: Awaited<ReturnType<typeof fixture>>) {
  f.panel.dom.launcherButton.dispatchEvent(new Event("click"));
  expect(f.panel.isOpen()).toBe(true);
  expect(f.documentRoot.activeElement).toBe(f.panel.dom.composerInput);
}

function dismiss(f: Awaited<ReturnType<typeof fixture>>, control = "closeButton") {
  if (control === "Escape") {
    f.panel.root.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }));
  } else {
    f.panel.dom[control].dispatchEvent(new Event("click"));
  }
  expect(f.panel.isOpen()).toBe(false);
  expect(f.documentRoot.activeElement).toBe(f.outside);
}

function expectDismissed(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.panel.isOpen()).toBe(false);
  expect(f.panel.panel.hidden).toBe(true);
  expect(f.documentRoot.activeElement).toBe(f.outside);
  expect(f.shell.showToast).not.toHaveBeenCalled();
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

test.each(["closeButton", "mascotButton", "launcherButton", "Escape"])(
  "%s cancels pending snapshot opening without restoring SPARK focus", async (control) => {
    const f = await fixture();
    const pending = deferred<typeof f.result>();
    f.client.loadSparkChat.mockReturnValueOnce(pending.promise);
    launch(f);
    dismiss(f, control);
    pending.resolve(f.result);
    await finishBrowserTurn();
    expectDismissed(f);
  },
);

test("minimize cancels pending targeted history opening without restoring SPARK focus", async () => {
  const f = await fixture();
  const pending = deferred<boolean>();
  f.result.readState.unreadMessageIds = [7];
  f.conversation.session.openSession.mockReturnValueOnce(pending.promise);
  launch(f);
  await vi.waitFor(() => expect(f.conversation.session.openSession).toHaveBeenCalledWith("spark", expect.objectContaining({
    page: expect.objectContaining({ targetMessageId: "7" }),
  })));
  dismiss(f);
  pending.resolve(true);
  await finishBrowserTurn();
  expectDismissed(f);
});

test.each(["snapshot", "history"])("a cancelled %s opening does not report its late failure", async (phase) => {
  const f = await fixture();
  const snapshot = deferred<typeof f.result>();
  const history = deferred<boolean>();
  if (phase === "snapshot") f.client.loadSparkChat.mockReturnValueOnce(snapshot.promise);
  else {
    f.result.readState.unreadMessageIds = [7];
    f.conversation.session.openSession.mockReturnValueOnce(history.promise);
  }
  launch(f);
  if (phase === "history") await vi.waitFor(() => expect(f.conversation.session.openSession).toHaveBeenCalledOnce());
  dismiss(f);
  if (phase === "snapshot") snapshot.reject(new Error("late snapshot failure"));
  else history.reject(new Error("late history failure"));
  await finishBrowserTurn();
  expectDismissed(f);
});

test("an explicit opening after cancellation can show and focus SPARK again", async () => {
  const f = await fixture();
  const pending = deferred<typeof f.result>();
  f.client.loadSparkChat.mockReturnValueOnce(pending.promise);
  launch(f);
  dismiss(f);
  pending.resolve(f.result);
  await finishBrowserTurn();
  expectDismissed(f);
  expect(await f.feature.open()).toBe(true);
  expect(f.panel.isOpen()).toBe(true);
  expect(f.panel.panel.hidden).toBe(false);
  expect(f.documentRoot.activeElement).toBe(f.panel.dom.composerInput);
});

async function connectNotifications(f: Awaited<ReturnType<typeof fixture>>) {
  const notice = { id: "notice", kind: "reply", environmentId: "prod", sessionId: "spark", readAt: null,
    sourceUrl: "/home?environment=prod&spark=1&message=7&messageCreatedAt=7&request=req-7" };
  const assign = vi.fn();
  Object.assign(window, { location: { href: "http://localhost/notifications?environment=prod", assign } });
  const notifications = createNotificationsFeature({
    dom: { notificationsWorkspaceButton: new ElementStub(f.documentRoot) },
    state: { connected: true },
    client: { supportsNotifications: () => true, markNotificationsRead: vi.fn(async () => {}),
      listNotifications: vi.fn(async () => ({ items: [notice], unreadCount: 1 })) },
    shell: { ...f.shell, activeWorkspace: () => "notifications", navigationRevision: () => 0 },
    getEnvironmentId: () => "prod", send: vi.fn(),
  });
  const openSession = vi.spyOn(f.feature, "openSession");
  notifications.setCompanionChat(f.feature);
  await notifications.setReady();
  return { assign, notice, openSession, open: (item = notice) => capture.notificationActions.openSource(item) };
}

test.each([
  ["snapshot", "resolved"], ["history", "resolved"], ["snapshot", "rejected"], ["history", "rejected"],
])("a notification %s opening stays cancelled after its %s response without URL fallback", async (phase, outcome) => {
  const f = await fixture();
  const notifications = await connectNotifications(f);
  await f.feature.open();
  const pending = deferred<any>();
  if (phase === "snapshot") f.client.loadSparkChat.mockReturnValueOnce(pending.promise);
  else f.conversation.session.openSession.mockReturnValueOnce(pending.promise);
  const opening = notifications.open();
  if (phase === "snapshot") await vi.waitFor(() => expect(notifications.openSession).toHaveBeenCalledOnce());
  else await vi.waitFor(() => expect(f.conversation.session.openSession).toHaveBeenCalledOnce());
  dismiss(f);
  if (outcome === "rejected") pending.reject(new Error("late notification failure"));
  else pending.resolve(phase === "snapshot" ? f.result : true);
  await opening;
  expectDismissed(f);
  expect(notifications.assign).not.toHaveBeenCalled();
});

test("a dismissed notification stays handled when its initial configuration refresh later rejects", async () => {
  const initialSnapshot = deferred<any>();
  const f = await fixture(initialSnapshot.promise);
  const notifications = await connectNotifications(f);
  launch(f);
  const queuedRefresh = deferred<typeof f.result>();
  f.client.loadSparkChat.mockReturnValueOnce(queuedRefresh.promise);
  const opening = notifications.open();
  await vi.waitFor(() => expect(notifications.openSession).toHaveBeenCalledOnce());
  dismiss(f);
  initialSnapshot.resolve(f.result);
  await vi.waitFor(() => expect(f.client.loadSparkChat).toHaveBeenCalledTimes(2));
  queuedRefresh.reject(new Error("late initial configuration failure"));
  await opening;
  expectDismissed(f);
  expect(notifications.assign).not.toHaveBeenCalled();
});

test.each(["snapshot", "history"])("an uncancelled notification %s failure preserves its error and URL fallback", async (phase) => {
  const f = await fixture();
  const notifications = await connectNotifications(f);
  const failure = new Error("notification opening failed");
  if (phase === "snapshot") f.client.loadSparkChat.mockRejectedValueOnce(failure);
  else f.conversation.session.openSession.mockRejectedValueOnce(failure);
  await notifications.open();
  expect(f.shell.showToast).toHaveBeenCalledWith(expect.stringContaining(failure.message), "failed");
  expect(notifications.assign).toHaveBeenCalledExactlyOnceWith(notifications.notice.sourceUrl);
  expect(f.panel.isOpen()).toBe(false);
});

test.each(["ordinary", "unknown SPARK"])("a notification for an %s source retains its URL fallback", async (kind) => {
  const f = await fixture();
  const notifications = await connectNotifications(f);
  const sourceUrl = kind === "ordinary" ? "/chat?environment=prod&session=ordinary" : notifications.notice.sourceUrl;
  await notifications.open({ ...notifications.notice, sessionId: "ordinary", sourceUrl });
  expect(notifications.assign).toHaveBeenCalledExactlyOnceWith(sourceUrl);
  expect(f.shell.showToast).not.toHaveBeenCalled();
  expect(f.panel.isOpen()).toBe(false);
});

test("an uncancelled recognized notification opens SPARK without URL fallback", async () => {
  const f = await fixture();
  const notifications = await connectNotifications(f);
  await notifications.open();
  expect(f.panel.isOpen()).toBe(true);
  expect(f.documentRoot.activeElement).toBe(f.panel.dom.composerInput);
  expect(notifications.assign).not.toHaveBeenCalled();
});
