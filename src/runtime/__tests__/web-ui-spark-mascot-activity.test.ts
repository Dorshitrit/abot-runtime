import { installSparkDocument, sparkDom } from "./support/spark-composer-dom.js";
import { createSparkQueueFixture } from "./support/spark-composer-queue.js";
import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser composition module.
import { createSparkChatFeature } from "../../web-ui/app/spark-chat-feature.js";
// @ts-expect-error Browser transport composition module.
import { createAppRealtimeTransport } from "../../web-ui/app/app-realtime-transport.js";

const capture = vi.hoisted(() => ({ conversation: null as any, queue: null as any, panelDom: null as any, transport: null as any, open: false }));
vi.mock("../../web-ui/app/services/workspace-state.js", () => ({ workspaceQueue: () => capture.queue, workspaceStorage: () => undefined }));
vi.mock("../../web-ui/app/spark-chat-conversation.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, (...args: any[]) => any>>();
  return { createSparkChatConversation: (...args: any[]) => (capture.conversation = actual.createSparkChatConversation(...args)) };
});
vi.mock("../../web-ui/app/controllers/conversation-view-feature.js", () => ({
  createConversationViewFeature: () => new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock("../../web-ui/app/components/spark-chat/settings.js", () => ({ createSparkChatSettings: () => ({ render: vi.fn() }) }));
vi.mock("../../web-ui/app/components/spark-chat/panel.js", () => ({
  createSparkChatPanel: () => ({ dom: capture.panelDom, isOpen: () => capture.open, setOpen: vi.fn((open: boolean) => { capture.open = open; }), setAvailable: vi.fn(),
    onToggle: vi.fn(), showNotice: vi.fn(), hideNotice: vi.fn(), setUnread: vi.fn(), resetPosition: vi.fn() }),
}));
vi.mock("../../web-ui/app/services/realtime-transport.js", () => ({
  createRealtimeTransport: (options: unknown) => {
    capture.transport = options;
    return { send: vi.fn(() => true), connect: vi.fn() };
  },
}));


async function harness(active = true) {
  capture.open = false;
  installSparkDocument();
  capture.queue = createSparkQueueFixture().queue;
  const dom = sparkDom(); dom.environmentSelect.value = "dev";
  capture.panelDom = sparkDom();
  const snapshot = { sessionId: "spark-companion", kind: "spark", messages: [],
    requests: active ? [{ requestId: "spark-request", status: "streaming" }] : [] };
  const client = {
    supportsSparkChat: () => true, listModels: async () => ({ profiles: [{ id: "model" }] }),
    loadSparkChat: vi.fn(async () => ({ sessionId: "spark-companion", modelProfileId: "model", snapshot,
      readState: { readGeneration: "same", unreadMessageIds: [], unreadCount: 0 } })),
    postChatMessage: vi.fn<(...args: any[]) => Promise<string>>(),
    loadSession: vi.fn(async () => snapshot), fetchRequestEvents: vi.fn(async () => []),
  };
  const appState = { connected: true, runtimeAvailability: { status: "ready" },
    currentSessionId: "ordinary", activeRequestId: "ordinary-request", messages: [{ id: "ordinary-answer" }] };
  const shell = { isWorkspaceAvailable: () => true, subscribeRuntimeAvailabilityChange: vi.fn(), showToast: vi.fn(), subscribeWorkspaceChange: vi.fn() };
  const realtime = createAppRealtimeTransport({ state: appState, getConfig: () => ({}), onMessage: vi.fn(),
    setConnectionLabel: vi.fn(), rejectPendingSteers: vi.fn(), recordControlEvent: vi.fn(), onConnected: vi.fn() });
  const feature = createSparkChatFeature({ dom, state: appState, client, shell, realtime,
    getEnvironmentId: () => dom.environmentSelect.value });
  feature.bind(); feature.environmentChanged();
  await vi.waitFor(() => expect(capture.conversation.state.currentSessionId).toBe("spark-companion"));
  expect(client.loadSession).not.toHaveBeenCalled();
  const conversation = capture.conversation;
  await vi.waitFor(() => expect(conversation.state.currentSessionId).toBe("spark-companion"));
  const expectWorking = (expected: boolean) => {
    for (const target of [capture.panelDom.launcherButton, capture.panelDom.mascotButton]) {
      expect(target.classList.contains("spark-is-working")).toBe(expected);
      expect(target.attributes.get("aria-description")).toBe(expected ? "SPARK is working." : "");
    }
  };
  const event = (name: string, sequence: number) => capture.transport.onMessage({
    type: "event", name, requestId: "spark-request", sessionId: "spark-companion", environment: "dev",
    executionId: "execution", tool: "write_file", approvalId: "approval", eventSequence: sequence,
  });
  return { dom, snapshot, client, appState, conversation, feature, realtime, expectWorking, event };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

test("hydrates active work with a closed popup and keeps both mascot locations in sync", async () => {
  const h = await harness();
  await vi.waitFor(() => h.expectWorking(true));
  capture.panelDom.launcherButton.classList.add("spark-launcher-floating");
  h.conversation.update(); h.expectWorking(true);
  expect(h.appState.currentSessionId).toBe("ordinary");
  expect(h.appState.activeRequestId).toBe("ordinary-request");
  h.conversation.reset(); h.expectWorking(false);
});

test("pauses for an approval and resumes when the same tool starts", async () => {
  const h = await harness();
  await vi.waitFor(() => h.expectWorking(true));
  h.event("tool.approval.required", 1); h.expectWorking(false);
  h.event("tool.approval.granted", 2); h.expectWorking(true);
  h.event("tool.started", 3); h.expectWorking(true);
});

test.each(["onClose", "onError"])("stops on transport %s and resumes after reconnect", async (transition) => {
  const h = await harness();
  await vi.waitFor(() => h.expectWorking(true));
  capture.transport[transition](); h.expectWorking(false);
  capture.transport.onOpen();
  await vi.waitFor(() => h.expectWorking(true));
});

test.each(["completed", "failed"])("stops when the request is %s without reopening the popup", async (type) => {
  const h = await harness();
  await vi.waitFor(() => h.expectWorking(true));
  h.snapshot.requests[0]!.status = type;
  capture.transport.onMessage({ type, requestId: "spark-request", sessionId: "spark-companion",
    environment: "dev", output: "Done", error: "Failed" });
  h.expectWorking(false);
  await vi.waitFor(() => expect(h.conversation.state.activeRequestId).toBe(""));
});

test("composer submission alone and an unrelated active conversation do not claim SPARK is working", async () => {
  const h = await harness(false);
  h.expectWorking(false);
  await h.feature.open();
  let refuse!: (error: Error) => void;
  h.client.postChatMessage.mockReturnValueOnce(new Promise((_resolve, reject) => { refuse = reject; }));
  capture.panelDom.composerInput.value = "New SPARK request";
  capture.panelDom.composerInput.dispatchEvent(new Event("input"));
  capture.panelDom.composerForm.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(h.client.postChatMessage).toHaveBeenCalledOnce());
  expect(h.conversation.state.composerSending).toBe(true);
  h.conversation.update(); h.expectWorking(false);
  refuse(Object.assign(new Error("Request refused"), { status: 400 }));
  await vi.waitFor(() => expect(h.conversation.state.composerSending).toBe(false));
  h.conversation.update(); h.expectWorking(false);
});

test("connection observers can detach without changing the existing connected-only subscription", () => {
  const state = { connected: false };
  const realtime = createAppRealtimeTransport({ state, getConfig: () => ({}), onMessage: vi.fn(),
    setConnectionLabel: vi.fn(), rejectPendingSteers: vi.fn(), recordControlEvent: vi.fn(), onConnected: vi.fn() });
  const changes: boolean[] = [];
  const connected = vi.fn();
  const unsubscribe = realtime.subscribeConnectionChanged(() => changes.push(state.connected));
  realtime.subscribeConnected(connected);
  capture.transport.onOpen(); capture.transport.onClose(); capture.transport.onError();
  expect(changes).toEqual([true, false, false]);
  expect(connected).toHaveBeenCalledOnce();
  unsubscribe(); capture.transport.onOpen();
  expect(changes).toEqual([true, false, false]);
  expect(connected).toHaveBeenCalledTimes(2);
});
