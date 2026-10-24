import { installSparkDocument, sparkDom } from "./support/spark-composer-dom.js";
import { createSparkQueueFixture } from "./support/spark-composer-queue.js";
import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser composition module.
import { createSparkChatFeature } from "../../web-ui/app/spark-chat-feature.js";
// @ts-expect-error Browser composition module.
import { createAppEventBindings } from "../../web-ui/app/controllers/app-event-bindings.js";

vi.mock("../../web-ui/app/components/confirmation-dialog.js", () => ({ confirmDialog: vi.fn(async () => true) }));

const capture = vi.hoisted(() => ({ conversation: null as any, queue: null as any, panelDom: null as any, open: false }));
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

const sparkScope = { environmentId: "dev", sessionId: "spark-companion" };
const file = { id: "queued-file", name: "idea.txt", storageRef: "spark-companion/queued-file", mimeType: "text/plain", environment: "dev", sessionId: "spark-companion" };

const addedFile = { ...file, id: "added-file", storageRef: "spark-companion/added-file" };

async function harness() {
  capture.open = false;
  const documentRoot = installSparkDocument();
  const queueFixture = createSparkQueueFixture();
  capture.queue = queueFixture.queue;
  let savedEnvironment = "dev";
  const dom = sparkDom(); dom.environmentSelect.value = "dev";
  capture.panelDom = sparkDom();
  const snapshot = { sessionId: "spark-companion", kind: "spark", messages: [], requests: [] };
  const readState = { readGeneration: "same", unreadMessageIds: [], unreadCount: 0 };
  const client = {
    supportsSparkChat: () => true, listModels: async () => ({ profiles: [{ id: "model" }] }),
    loadSparkChat: vi.fn(async () => ({ sessionId: "spark-companion", modelProfileId: "model", toolPermissionMode: "ask", snapshot, readState })),
    loadSession: vi.fn(async () => snapshot),
    postChatMessage: vi.fn(async () => { throw Error("POST could not be confirmed"); }),
    deleteAttachment: vi.fn(async () => {}),
    uploadAttachment: vi.fn(async () => addedFile),
  };
  const ordinaryState = { connected: true, runtimeAvailability: { status: "ready" }, currentSessionId: "ordinary", messages: [{ id: "ordinary-answer" }] };
  const shell = { isWorkspaceAvailable: () => true, subscribeRuntimeAvailabilityChange: vi.fn(), showToast: vi.fn(), subscribeWorkspaceChange: vi.fn(), prepareWorkspaceActivation: async () => () => true };
  const feature = createSparkChatFeature({ dom, state: ordinaryState, client, shell,
    realtime: { subscribeMessages: vi.fn(), subscribeConnected: vi.fn(), send: () => true }, getEnvironmentId: () => dom.environmentSelect.value });
  feature.bind(); feature.environmentChanged();
  await vi.waitFor(() => expect(capture.conversation.state.currentSessionId).toBe("spark-companion"));
  expect(client.loadSession).not.toHaveBeenCalled();
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
  const store = queueFixture.queue;
  const queueItem = { waitForRequestId: "old-request", text: "Original queued text", attachments: [file], agentMode: "reasoning", toolPermissionMode: "ask", modelPreference: null };
  await store.enqueue({ environmentId: "dev", sessionId: "ordinary" }, { ...queueItem, text: "Unrelated ordinary queue", attachments: [] });
  const ordinaryQueue = store.list({ environmentId: "dev", sessionId: "ordinary" });
  await store.enqueue(sparkScope, queueItem);
  await conversation.queue.drain({ ...sparkScope, terminalRequestId: "old-request" });
  expect(client.postChatMessage).toHaveBeenCalledOnce();
  expect(store.getBlockedRelease(sparkScope)?.owner.state).toBe("uncertain");
  await feature.open();
  expect(capture.panelDom.composerInput.value).toBe("");
  expect(conversation.state.pendingAttachments).toEqual([]);
  const review = capture.panelDom.composerForm.querySelector("button");
  expect(review?.textContent).toBe("Review message");
  review.dispatchEvent(new Event("click"));
  await vi.waitFor(() => expect(capture.panelDom.composerInput.value).toBe("Original queued text"));
  expect(conversation.state.pendingAttachments).toEqual([file]);
  capture.panelDom.composerInput.value = "Edited recovered text";
  capture.panelDom.composerInput.dispatchEvent(new Event("input"));
  await conversation.attachments.upload({ name: "added.txt", type: "text/plain" });
  const release = store.getBlockedRelease(sparkScope)!;
  return { feature, dom, client, ordinaryState, actions, bindings, conversation, store, ordinaryQueue, ordinaryCommit, release, addedFile,
    failStorage: queueFixture.failStorage };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("SPARK recovered Send next navigation", () => {
  test("accepted selector change saves the owned draft and files and restores only on return", async () => {
    const h = await harness();
    h.dom.environmentSelect.value = "prod";
    h.dom.environmentSelect.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(h.client.loadSparkChat).toHaveBeenCalledWith("prod"));
    expect(h.store.getBlockedRelease(sparkScope)?.item).toMatchObject({ text: "Edited recovered text", attachments: [file, h.addedFile] });
    expect(h.store.getBlockedRelease(sparkScope)?.releaseToken).toBe(h.release.releaseToken);
    expect(capture.panelDom.composerInput.value).toBe("");
    expect(h.conversation.state.pendingAttachments).toEqual([]);
    expect(h.client.deleteAttachment).not.toHaveBeenCalled();
    expect(h.client.postChatMessage).toHaveBeenCalledOnce();
    await h.bindings.changeEnvironment("dev");
    await vi.waitFor(() => expect(capture.panelDom.composerInput.value).toBe("Edited recovered text"));
    expect(h.conversation.state.pendingAttachments).toEqual([file, h.addedFile]);
    expect(h.store.getBlockedRelease(sparkScope)?.owner.state).toBe("editing");
    expect(h.client.postChatMessage).toHaveBeenCalledOnce();
    expect(h.client.deleteAttachment).not.toHaveBeenCalled();
    expect(h.store.list({ environmentId: "dev", sessionId: "ordinary" })).toEqual(h.ordinaryQueue);
  });

  test("ordinary navigation veto leaves SPARK's recovery untouched despite its earlier change listener", async () => {
    const h = await harness(); h.actions.beforeEnvironmentChange.mockReturnValue(false);
    const previousLoads = h.client.loadSparkChat.mock.calls.length;
    h.dom.environmentSelect.value = "prod";
    h.dom.environmentSelect.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(h.actions.beforeEnvironmentChange).toHaveBeenCalled());
    expect(h.dom.environmentSelect.value).toBe("dev");
    expect(capture.panelDom.composerInput.value).toBe("Edited recovered text");
    expect(h.conversation.state.pendingAttachments).toEqual([file, h.addedFile]);
    expect(h.client.loadSparkChat).toHaveBeenCalledTimes(previousLoads);
    expect(h.client.deleteAttachment).not.toHaveBeenCalled();
    expect(h.ordinaryCommit).not.toHaveBeenCalled();
  });

  test("SPARK storage failure vetoes programmatic navigation without committing ordinary recovery", async () => {
    const h = await harness(); h.failStorage();
    expect(await h.bindings.changeEnvironment("prod")).toBe(false);
    expect(h.dom.environmentSelect.value).toBe("dev");
    expect(capture.panelDom.composerInput.value).toBe("Edited recovered text");
    expect(h.conversation.state.pendingAttachments).toEqual([file, h.addedFile]);
    expect(h.store.getBlockedRelease(sparkScope)?.owner.state).toBe("editing");
    expect(h.store.getBlockedRelease(sparkScope)?.releaseToken).toBe(h.release.releaseToken);
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
    expect(h.store.getBlockedRelease(sparkScope)?.releaseToken).toBe(h.release.releaseToken);
    expect(h.client.deleteAttachment).not.toHaveBeenCalled();
    expect(h.actions.clearAttachments).not.toHaveBeenCalled();
  });
});
