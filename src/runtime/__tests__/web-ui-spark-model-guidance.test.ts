import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser composition.
import { createSparkChatFeature } from "../../web-ui/app/spark-chat-feature.js";
// @ts-expect-error Browser renderer.
import { createConversationView } from "../../web-ui/app/components/conversation-view.js";
// @ts-expect-error Browser presentation.
import { createSparkChatEmptyState } from "../../web-ui/app/components/spark-chat/empty-state.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

const capture = vi.hoisted(() => ({ conversation: null as any, panel: null as any, empty: null as any }));
vi.mock("../../web-ui/app/spark-chat-conversation.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, (...args: any[]) => any>>();
  return { createSparkChatConversation: (...args: any[]) => (capture.conversation = actual.createSparkChatConversation(...args)) };
});
vi.mock("../../web-ui/app/controllers/conversation-view-feature.js", () => ({
  createConversationViewFeature: (options: any) => {
    const render = () => {
      capture.empty.innerHTML = "";
      if (options.getMessages().length) return;
      if (options.emptyState.render) options.emptyState.render(capture.empty);
      else capture.empty.textContent = options.emptyState.title + options.emptyState.copy;
    };
    return new Proxy({ render }, { get: (target, key) => key === "render" ? target.render : vi.fn() });
  },
}));
vi.mock("../../web-ui/app/components/spark-chat/settings.js", () => ({ createSparkChatSettings: () => ({ render: vi.fn() }) }));
vi.mock("../../web-ui/app/components/spark-chat/panel.js", () => ({ createSparkChatPanel: () => capture.panel }));

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

async function harness(modelProfileId: string | null, profiles = [{ id: "model" }]) {
  const fakeDocument: any = { activeElement: null };
  fakeDocument.createElement = (tag: string) => new FakeElement(tag, fakeDocument);
  const empty = fakeDocument.createElement("div") as FakeElement;
  capture.empty = empty;
  const documentRoot = Object.assign(new ElementStub(), { createElement: () => new ElementStub() });
  vi.stubGlobal("document", documentRoot);
  vi.stubGlobal("window", Object.assign(new ElementStub(), { setTimeout, requestAnimationFrame: vi.fn() }));
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  const baseDom = domStub(); baseDom.environmentSelect.value = "dev";
  const learningRoot = fakeDocument.createElement("div") as FakeElement;
  for (const view of ["insights", "activity", "applications", "chat", "settings", "usage"]) {
    const tab = fakeDocument.createElement("button"); tab.setAttribute("data-learning-tab", view);
    const panel = fakeDocument.createElement("section"); panel.setAttribute("data-learning-panel", view); panel.hidden = true;
    learningRoot.append(tab); learningRoot.append(panel);
  }
  const selector = fakeDocument.createElement("select") as FakeElement;
  selector.setAttribute("data-learning-setting", "proactiveModelProfileId");
  learningRoot.querySelector('[data-learning-panel="settings"]')!.append(selector);
  const dom = new Proxy(baseDom, { get: (target, key) => key === "learningRoot" ? learningRoot : Reflect.get(target, key) });
  const panelDom = domStub();
  let toggle = (_value: boolean) => {};
  let open = false;
  capture.panel = { dom: panelDom, isOpen: () => open, setOpen: vi.fn((value: boolean) => { open = value; toggle(value); }),
    onToggle: (callback: (value: boolean) => void) => { toggle = callback; }, setAvailable: vi.fn(),
    showNotice: vi.fn(), hideNotice: vi.fn(), setUnread: vi.fn(), resetPosition: vi.fn() };
  const snapshot = { sessionId: "spark-companion", kind: "spark", messages: [] as any[], requests: [] };
  const result = { sessionId: "spark-companion", modelProfileId, toolPermissionMode: "ask", snapshot,
    readState: { readGeneration: "same", unreadMessageIds: [], unreadCount: 0 } };
  const client = { supportsSparkChat: () => true, listModels: vi.fn(async () => ({ profiles })),
    loadSparkChat: vi.fn(async () => result), loadSession: vi.fn(async () => snapshot),
    postChatMessage: vi.fn(async () => ({})), uploadAttachment: vi.fn(), deleteAttachment: vi.fn() };
  const ordinary = { connected: true, runtimeAvailability: { status: "ready" }, currentSessionId: "ordinary", agentMode: "deep",
    messages: [{ id: "ordinary-message" }], config: { embedding: { enabled: false }, learning: { proactiveEnabled: false } } };
  const unchanged = structuredClone(ordinary);
  const shell = { showToast: vi.fn(), subscribeWorkspaceChange: vi.fn(), activateWorkspace: vi.fn(() => true) };
  const listeners: any = {};
  const feature = createSparkChatFeature({ dom, state: ordinary, client, shell, getEnvironmentId: () => dom.environmentSelect.value,
    realtime: { subscribeMessages: (fn: any) => { listeners.message = fn; }, subscribeConnected: vi.fn(), send: () => true } });
  feature.bind(); feature.environmentChanged();
  await vi.waitFor(() => expect(client.loadSession).toHaveBeenCalledOnce());
  await feature.open();
  panelDom.composerInput.value = "My draft";
  panelDom.composerInput.dispatchEvent(new Event("input"));
  return { feature, dom, empty, selector, learningRoot, fakeDocument, panelDom, result, client, shell, ordinary, unchanged, listeners,
    conversation: capture.conversation };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("SPARK missing-model guidance", () => {
  test.each([null, "deleted-profile"])("blocks %s model and opens its exact setting without changing ordinary chat", async (model) => {
    const h = await harness(model);
    expect(h.empty.textContent).not.toContain("What’s on your mind?");
    const setup = h.empty.querySelector("button");
    expect(setup).not.toBeNull();
    expect(h.panelDom.sendButton.disabled).toBe(true);
    expect(h.panelDom.attachmentButton.disabled).toBe(true);
    h.panelDom.composerForm.dispatchEvent(new Event("submit", { cancelable: true }));
    await expect(h.conversation.attachments.upload({ name: "note.txt", type: "text/plain" })).rejects.toThrow("Configure a provider and model");
    expect(h.client.postChatMessage).not.toHaveBeenCalled();
    expect(h.client.uploadAttachment).not.toHaveBeenCalled();
    setup!.dispatch("click");
    expect(h.shell.activateWorkspace).toHaveBeenCalledWith("learning");
    expect(h.learningRoot.querySelector('[data-learning-panel="settings"]')!.hidden).toBe(false);
    expect(h.fakeDocument.activeElement).toBe(h.selector);
    expect(capture.panel.setOpen).toHaveBeenLastCalledWith(false, { focus: false });
    expect(h.panelDom.composerInput.value).toBe("My draft");
    expect(h.ordinary).toEqual(h.unchanged);
  });

  test("a selected available model needs no optional setup or enabled proactive mode", async () => {
    const h = await harness("model");
    expect(h.empty.querySelector("button")).toBeNull();
    expect(h.empty.textContent).toContain("What’s on your mind?");
    expect(h.panelDom.sendButton.disabled).toBe(false);
    expect(h.panelDom.attachmentButton.disabled).toBe(false);
    h.ordinary.runtimeAvailability.status = "unavailable";
    h.conversation.update();
    expect(h.panelDom.sendButton.disabled).toBe(true);
    expect(h.empty.querySelector("button")).toBeNull();
    expect(h.ordinary.currentSessionId).toBe("ordinary");
  });

  test("saving a model refreshes empty guidance and preserves draft without auto-send", async () => {
    const h = await harness(null);
    h.result.modelProfileId = "model";
    h.listeners.message({ type: "learning.changed", environmentId: "dev" });
    await vi.waitFor(() => expect(h.panelDom.sendButton.disabled).toBe(false));
    expect(h.empty.querySelector("button")).toBeNull();
    expect(h.empty.textContent).toContain("What’s on your mind?");
    expect(h.panelDom.composerInput.value).toBe("My draft");
    expect(h.client.postChatMessage).not.toHaveBeenCalled();
    expect(h.ordinary).toEqual(h.unchanged);
  });

  test("navigation veto keeps the setup guidance and current popup open", async () => {
    const h = await harness(null); h.shell.activateWorkspace.mockReturnValue(false);
    h.empty.querySelector("button")!.dispatch("click");
    expect(capture.panel.isOpen()).toBe(true);
    expect(h.fakeDocument.activeElement).toBeNull();
  });
});


test("ordinary empty conversations retain their original prompt and no setup action", () => {
  const documentRoot: any = {};
  documentRoot.createElement = (tag: string) => new FakeElement(tag, documentRoot);
  const list = documentRoot.createElement("div") as FakeElement;
  const view = createConversationView({
    documentRoot, viewport: {}, dom: { messagesList: list, jumpToLatestButton: documentRoot.createElement("button") },
    getMessages: () => [], getActivityForMessage: () => ({ events: [] }), showContextWindow: false,
    scrollBehavior: { afterRender() {} },
  });
  view.render();
  expect(list.textContent).toContain("What would you like to work on?");
  expect(list.querySelector("button")).toBeNull();
});

test("unresolved configuration does not mistake loading or a transport failure for missing setup", () => {
  const documentRoot: any = {};
  documentRoot.createElement = (tag: string) => new FakeElement(tag, documentRoot);
  const list = documentRoot.createElement("div") as FakeElement;
  createSparkChatEmptyState({ getConfiguration: () => undefined, onOpenModelSettings: vi.fn() }).render(list);
  expect(list.querySelector("button")).toBeNull();
  expect(list.textContent).not.toContain("Choose a model");
});
