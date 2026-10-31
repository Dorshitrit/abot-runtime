import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser composition module.
import { createSparkChatFeature } from "../../web-ui/app/spark-chat-feature.js";
// @ts-expect-error Browser composition module.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
import { createWorkspaceShellHarness, isAvailableWorkspaceFocus } from "./support/workspace-shell-harness.js";

const capture = vi.hoisted(() => ({ panel: null as any, conversation: null as any }));
vi.mock("../../web-ui/app/components/spark-chat/panel.js", () => ({ createSparkChatPanel: () => capture.panel }));
vi.mock("../../web-ui/app/spark-chat-conversation.js", () => ({ createSparkChatConversation: () => capture.conversation }));
vi.mock("../../web-ui/app/components/spark-chat/settings.js", () => ({ createSparkChatSettings: () => ({ render: vi.fn() }) }));

class ElementStub extends EventTarget {
  value = "prod";
  hidden = true;
  parentElement: ElementStub | null = null;
  contains(candidate: ElementStub | null): boolean {
    if (!candidate) return false;
    if (candidate === this) return true;
    return this.contains(candidate.parentElement);
  }
  closest = () => null;
  querySelectorAll = () => [];
}

function fixture() {
  const workspace = createWorkspaceShellHarness(1259, { evictHiddenFocus: true });
  const documentRoot = Object.assign(new EventTarget(), { visibilityState: "visible" });
  Object.defineProperty(documentRoot, "activeElement", { get: () => workspace.documentRoot.activeElement });
  vi.stubGlobal("document", documentRoot);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { requestAnimationFrame: vi.fn() }));
  const shell = createWorkspaceShell(workspace);
  shell.bind(); shell.load();
  const state = { runtimeAvailability: { status: "loading" }, connected: true };
  shell.runtimeAvailabilityChanged(state.runtimeAvailability);
  let toggle = (_opened: boolean) => {};
  let opened = false;
  const panel = {
    root: new ElementStub(),
    dom: { settingsButton: new ElementStub(), messagesList: new ElementStub(), launcherButton: new ElementStub(), composerForm: new ElementStub() },
    available: false, isOpen: () => opened,
    setOpen(value: boolean) { if (opened === value) return; opened = value; toggle(value); },
    setAvailable(value: boolean) {
      panel.available = value;
      if (value) return;
      const focused = document.activeElement as unknown as ElementStub;
      if (panel.root.contains(focused) || panel.dom.launcherButton.contains(focused)) workspace.documentRoot.activeElement = null;
      panel.setOpen(false);
    },
    onToggle(callback: typeof toggle) { toggle = callback; },
    hideNotice: vi.fn(), showNotice: vi.fn(), setUnread: vi.fn(),
  };
  panel.dom.messagesList.parentElement = panel.root;
  panel.dom.composerForm.parentElement = panel.root;
  capture.panel = panel;
  const conversationState = {
    messages: [] as any[], currentSessionId: "", composerSending: false, activeRequestId: "",
    requestMessages: new Map(), requestLifecycles: new Map(),
  };
  const conversation = {
    state: conversationState, bind: vi.fn(), render: vi.fn(), update: vi.fn(), status: vi.fn(),
    attachments: { removeUnsupportedImages: vi.fn() }, view: { closeFilePreview: vi.fn() },
    reset: vi.fn(() => { conversationState.messages = []; conversationState.currentSessionId = ""; }),
    session: { openSession: vi.fn(async (sessionId: string, options: any) => {
      conversationState.currentSessionId = sessionId;
      conversationState.messages = options.snapshot?.messages ?? [];
      return true;
    }) },
  };
  capture.conversation = conversation;
  const result = { sessionId: "spark", modelProfileId: "model", snapshot: { messages: [], requests: [] },
    readState: { unreadMessageIds: [], unreadCount: 0, readGeneration: "one" } };
  const client = { supportsSparkChat: vi.fn(() => true), loadSparkChat: vi.fn(async () => result),
    listModels: vi.fn(async () => ({ profiles: [{ id: "model" }] })) };
  const realtime = { subscribeMessages: vi.fn<(callback: any) => void>(), subscribeConnected: vi.fn<(callback: any) => void>(), send: vi.fn() };
  const dom = { environmentSelect: new ElementStub(), learningRoot: new ElementStub(), homeWorkspaceButton: workspace.dom.homeWorkspaceButton };
  const feature = createSparkChatFeature({ dom, state, client, shell, realtime, getEnvironmentId: () => dom.environmentSelect.value });
  feature.bind(); feature.environmentChanged();
  function applyAvailability(status: string, recovery?: string) {
    state.runtimeAvailability = { status };
    shell.runtimeAvailabilityChanged({ status, recovery });
  }
  const waitForReady = () => vi.waitFor(() => expect(conversation.state.currentSessionId).toBe("spark"));
  return { feature, panel, client, shell, conversation, realtime, result, workspace, applyAvailability, waitForReady };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("SPARK initial onboarding access", () => {
  test.each(["loading", "setup_required", "checking", "error"])("%s blocks launcher, direct entry and background requests", async (status) => {
    const f = fixture(); f.applyAvailability(status);
    expect(f.panel.available).toBe(false);
    f.panel.setOpen(true);
    expect(f.panel.isOpen()).toBe(false);
    expect(await f.feature.open("linked-message")).toBe(false);
    expect(await f.feature.openSession("spark", "linked-message")).toBe(false);
    f.realtime.subscribeConnected.mock.calls[0]![0]();
    f.realtime.subscribeMessages.mock.calls[0]![0]({ type: "learning.changed" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(f.client.loadSparkChat).not.toHaveBeenCalled();
    expect(f.client.listModels).not.toHaveBeenCalled();
  });

  test("Ready on Home enables and loads SPARK in the same environment", async () => {
    const f = fixture(); f.applyAvailability("ready"); await f.waitForReady();
    expect(f.shell.activeWorkspace()).toBe("home");
    expect(f.panel.available).toBe(true);
    expect(f.client.loadSparkChat).toHaveBeenCalledExactlyOnceWith("prod");
    expect(await f.feature.open()).toBe(true);
    expect(f.panel.isOpen()).toBe(true);
    f.applyAvailability("setup_required");
    expect(f.panel.available).toBe(false);
    expect(f.panel.isOpen()).toBe(false);
    expect(f.conversation.state.currentSessionId).toBe("");
  });

  test.each(["popup", "docked launcher", "floating launcher"])("setup restores focus from the %s before hiding SPARK", async (target) => {
    const f = fixture(); f.applyAvailability("ready"); await f.waitForReady();
    if (target === "popup") await f.feature.open();
    const launcher = f.panel.dom.launcherButton;
    launcher.parentElement = target === "docked launcher" ? new ElementStub() : null;
    const focused = target === "popup" ? f.panel.dom.messagesList : launcher;
    f.workspace.documentRoot.activeElement = focused as any;
    f.applyAvailability("setup_required");
    expect(f.panel.available).toBe(false);
    expect(f.panel.isOpen()).toBe(false);
    expect(f.workspace.documentRoot.activeElement).toBe(f.workspace.dom.homeWorkspaceButton);
    expect(isAvailableWorkspaceFocus(f.workspace.documentRoot.activeElement)).toBe(true);
  });

  test("hiding SPARK preserves focus outside its popup and launcher", async () => {
    const f = fixture(); f.applyAvailability("ready"); await f.waitForReady();
    await f.feature.open();
    f.workspace.dom.composerInput.focus();
    f.applyAvailability("setup_required");
    expect(f.panel.isOpen()).toBe(false);
    expect(f.workspace.documentRoot.activeElement).toBe(f.workspace.dom.composerInput);
  });

  test("configured refreshes and recovery preserve the open conversation", async () => {
    const f = fixture(); f.applyAvailability("ready"); await f.waitForReady();
    await f.feature.open();
    const loads = f.client.loadSparkChat.mock.calls.length;
    const resets = f.conversation.reset.mock.calls.length;
    f.applyAvailability("checking"); f.applyAvailability("error");
    f.applyAvailability("setup_required", "configuration");
    expect(f.panel.available).toBe(true);
    expect(f.panel.isOpen()).toBe(true);
    expect(f.client.loadSparkChat).toHaveBeenCalledTimes(loads);
    expect(f.conversation.reset).toHaveBeenCalledTimes(resets);
  });

  test("late snapshots cannot reopen a popup after setup interrupts its opening", async () => {
    const f = fixture();
    let finish!: (value: typeof f.result) => void;
    f.client.loadSparkChat.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    f.applyAvailability("ready");
    const opening = f.feature.open();
    f.applyAvailability("setup_required");
    finish(f.result);
    expect(await opening).toBe(false);
    await Promise.resolve();
    expect(f.panel.isOpen()).toBe(false);
    expect(f.conversation.state.currentSessionId).toBe("");
    expect(f.client.listModels).not.toHaveBeenCalled();
    f.applyAvailability("ready"); await f.waitForReady();
    expect(f.panel.available).toBe(true);
    expect(f.panel.isOpen()).toBe(false);
  });

  test("an earlier targeted history opening stays cancelled after setup becomes ready again", async () => {
    const f = fixture(); f.applyAvailability("ready"); await f.waitForReady();
    let finish!: () => void;
    f.conversation.session.openSession.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = () => resolve(true); }));
    const opening = f.feature.open("missing-target");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    f.applyAvailability("setup_required");
    f.applyAvailability("ready"); await f.waitForReady();
    finish();
    expect(await opening).toBe(false);
    expect(f.panel.available).toBe(true);
    expect(f.panel.isOpen()).toBe(false);
  });

  test("readiness never enables a backend without SPARK support", () => {
    const f = fixture(); f.client.supportsSparkChat.mockReturnValue(false);
    f.applyAvailability("ready");
    expect(f.panel.available).toBe(false);
    expect(f.client.loadSparkChat).not.toHaveBeenCalled();
  });
});
