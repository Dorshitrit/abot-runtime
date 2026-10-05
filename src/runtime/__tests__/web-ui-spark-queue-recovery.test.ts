import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser composition module.
import { createSparkChatFeature } from "../../web-ui/app/spark-chat-feature.js";
// @ts-expect-error Browser composition module.
import { createAppEventBindings } from "../../web-ui/app/controllers/app-event-bindings.js";
import { createSessionComposerQueue } from "../../web-ui/app/lib/session-composer-queue.js";

const capture = vi.hoisted(() => ({ conversation: null as any, panelDom: null as any }));
vi.mock("../../web-ui/app/spark-chat-conversation.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, (...args: any[]) => any>>();
  return { createSparkChatConversation: (...args: any[]) => (capture.conversation = actual.createSparkChatConversation(...args)) };
});
vi.mock("../../web-ui/app/controllers/conversation-view-feature.js", () => ({
  createConversationViewFeature: () => new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock("../../web-ui/app/components/spark-chat/settings.js", () => ({ createSparkChatSettings: () => ({ render: vi.fn() }) }));
vi.mock("../../web-ui/app/components/spark-chat/panel.js", () => ({
  createSparkChatPanel: () => ({ dom: capture.panelDom, isOpen: () => false, setOpen: vi.fn(), setAvailable: vi.fn(),
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
const sparkScope = { environmentId: "dev", sessionId: "spark-companion" };
const file = { id: "queued-file", name: "idea.txt", storageRef: "spark-companion/queued-file", mimeType: "text/plain", environment: "dev", sessionId: "spark-companion" };

async function harness() {
  const documentRoot = Object.assign(new ElementStub(), { createElement: () => new ElementStub() });
  vi.stubGlobal("document", documentRoot);
  vi.stubGlobal("window", Object.assign(new ElementStub(), { setTimeout, requestAnimationFrame: vi.fn() }));
  let savedEnvironment = "dev";
  let storageFailure = false;
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {
    if (storageFailure) throw Error("storage unavailable");
    values.set(key, value);
  } };
  vi.stubGlobal("localStorage", storage);
  const dom = domStub(); dom.environmentSelect.value = "dev";
  capture.panelDom = domStub();
  const snapshot = { sessionId: "spark-companion", kind: "spark", messages: [], requests: [] };
  const readState = { readGeneration: "same", unreadMessageIds: [], unreadCount: 0 };
  const client = {
    supportsSparkChat: () => true, listModels: async () => ({ profiles: [{ id: "model" }] }),
    loadSparkChat: vi.fn(async () => ({ sessionId: "spark-companion", modelProfileId: "model", toolPermissionMode: "ask", snapshot, readState })),
    loadSession: vi.fn(async () => snapshot),
    postChatMessage: vi.fn(async () => { throw Error("POST could not be confirmed"); }),
    deleteAttachment: vi.fn(async () => {}),
  };
  const ordinaryState = { connected: true, runtimeAvailability: { status: "ready" }, currentSessionId: "ordinary", messages: [{ id: "ordinary-answer" }] };
  const shell = { showToast: vi.fn(), subscribeWorkspaceChange: vi.fn(), prepareWorkspaceActivation: () => () => true };
  const feature = createSparkChatFeature({ dom, state: ordinaryState, client, shell,
    realtime: { subscribeMessages: vi.fn(), subscribeConnected: vi.fn(), send: () => true }, getEnvironmentId: () => dom.environmentSelect.value });
  feature.bind(); feature.environmentChanged();
  await vi.waitFor(() => expect(client.loadSession).toHaveBeenCalledOnce());
  const conversation = capture.conversation;
  const ordinaryCommit = vi.fn();
  const actions = {
    savedEnvironmentId: () => savedEnvironment, saveEnvironmentId: (value: string) => { savedEnvironment = value; },
    prepareQueueRecovery: vi.fn(() => ordinaryCommit as false | (() => void)), suspendQueueRecovery: vi.fn(() => true),
    beforeEnvironmentChange: vi.fn(() => true), renderAgentPicker: vi.fn(), invalidateSessionLoads: vi.fn(),
    clearAttachments: vi.fn(), resetLiveRequestView: vi.fn(), applyConversationChrome: vi.fn(), renderMessages: vi.fn(),
    loadModels: vi.fn(async () => {}), loadAgentMode: vi.fn(async () => {}), loadRuntimeConfig: vi.fn(async () => {}), restoreLastSession: vi.fn(async () => {}),
  };
  const bindings = createAppEventBindings({ state: ordinaryState, dom, shell, actions, modelSelector: {}, composerActions: {}, documentRoot });
  bindings.setEnvironmentChangePreparation(feature.prepareEnvironmentChange);
  bindings.bind();
  const store = createSessionComposerQueue({ storage });
  const queueItem = { waitForRequestId: "old-request", text: "Original queued text", attachments: [file], agentMode: "reasoning", toolPermissionMode: "ask", modelPreference: null };
  store.enqueue({ environmentId: "dev", sessionId: "ordinary" }, { ...queueItem, text: "Unrelated ordinary queue", attachments: [] });
  const ordinaryQueue = store.list({ environmentId: "dev", sessionId: "ordinary" });
  conversation.state.currentSessionId = "spark-companion";
  conversation.state.activeRequestId = "old-request";
  conversation.state.pendingAttachments = [file];
  await conversation.queue.enqueue("Original queued text");
  conversation.state.activeRequestId = "";
  await conversation.queue.drain({ ...sparkScope, terminalRequestId: "old-request" });
  expect(capture.panelDom.composerInput.value).toBe("Original queued text");
  expect(conversation.state.pendingAttachments).toEqual([file]);
  capture.panelDom.composerInput.value = "Edited recovered text";
  const addedFile = { ...file, id: "added-file", storageRef: "spark-companion/added-file" };
  conversation.state.pendingAttachments.push(addedFile);
  const release = store.getBlockedRelease(sparkScope)!;
  return { feature, dom, client, ordinaryState, actions, bindings, conversation, store, ordinaryQueue, ordinaryCommit, release, addedFile,
    failStorage: () => { storageFailure = true; } };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("SPARK recovered Send next navigation", () => {
  test("accepted selector change saves edited draft and files, frees its token, and restores only on return", async () => {
    const h = await harness();
    h.dom.environmentSelect.value = "prod";
    h.dom.environmentSelect.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(h.client.loadSparkChat).toHaveBeenCalledWith("prod"));
    expect(h.store.getBlockedRelease(sparkScope)?.item).toMatchObject({ text: "Edited recovered text", attachments: [file, h.addedFile] });
    expect(h.conversation.state.activeComposerQueueRecovery).toBeNull();
    expect(h.conversation.state.composerQueueRecoveredReleaseTokens.has(h.release.releaseToken)).toBe(false);
    expect(capture.panelDom.composerInput.value).toBe("");
    expect(h.conversation.state.pendingAttachments).toEqual([]);
    expect(h.client.deleteAttachment).not.toHaveBeenCalled();
    expect(h.client.postChatMessage).toHaveBeenCalledOnce();
    await h.bindings.changeEnvironment("dev");
    await vi.waitFor(() => expect(capture.panelDom.composerInput.value).toBe("Edited recovered text"));
    expect(h.conversation.state.pendingAttachments).toEqual([file, h.addedFile]);
    expect(h.conversation.state.composerQueueRecoveredReleaseTokens.has(h.release.releaseToken)).toBe(true);
    expect(h.client.postChatMessage).toHaveBeenCalledOnce();
    expect(h.client.deleteAttachment).not.toHaveBeenCalled();
    expect(h.store.list({ environmentId: "dev", sessionId: "ordinary" })).toEqual(h.ordinaryQueue);
  });

  test("ordinary navigation veto leaves SPARK's recovery untouched despite its earlier change listener", async () => {
    const h = await harness(); h.actions.beforeEnvironmentChange.mockReturnValue(false);
    h.dom.environmentSelect.value = "prod";
    h.dom.environmentSelect.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(h.dom.environmentSelect.value).toBe("dev");
    expect(capture.panelDom.composerInput.value).toBe("Edited recovered text");
    expect(h.conversation.state.pendingAttachments).toEqual([file, h.addedFile]);
    expect(h.client.loadSparkChat).toHaveBeenCalledOnce();
    expect(h.client.deleteAttachment).not.toHaveBeenCalled();
    expect(h.ordinaryCommit).not.toHaveBeenCalled();
  });

  test("SPARK storage failure vetoes programmatic navigation without committing ordinary recovery", async () => {
    const h = await harness(); h.failStorage();
    expect(await h.bindings.changeEnvironment("prod")).toBe(false);
    expect(h.dom.environmentSelect.value).toBe("dev");
    expect(capture.panelDom.composerInput.value).toBe("Edited recovered text");
    expect(h.conversation.state.pendingAttachments).toEqual([file, h.addedFile]);
    expect(h.conversation.state.composerQueueRecoveredReleaseTokens.has(h.release.releaseToken)).toBe(true);
    expect(h.conversation.state.activeComposerQueueRecovery.releaseToken).toBe(h.release.releaseToken);
    expect(h.client.deleteAttachment).not.toHaveBeenCalled();
    expect(h.ordinaryCommit).not.toHaveBeenCalled();
    expect(h.actions.clearAttachments).not.toHaveBeenCalled();
    expect(h.ordinaryState.currentSessionId).toBe("ordinary");
  });

  test("ordinary recovered-queue save failure does not commit prepared SPARK recovery", async () => {
    const h = await harness(); h.actions.prepareQueueRecovery.mockReturnValue(false);
    expect(await h.bindings.changeEnvironment("prod")).toBe(false);
    expect(h.dom.environmentSelect.value).toBe("dev");
    expect(capture.panelDom.composerInput.value).toBe("Edited recovered text");
    expect(h.conversation.state.pendingAttachments).toEqual([file, h.addedFile]);
    expect(h.conversation.state.activeComposerQueueRecovery.releaseToken).toBe(h.release.releaseToken);
    expect(h.client.deleteAttachment).not.toHaveBeenCalled();
    expect(h.actions.clearAttachments).not.toHaveBeenCalled();
  });
});
