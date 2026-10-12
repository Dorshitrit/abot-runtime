import { vi } from "vitest";
import { ContextElement } from "./composer-context-window-dom.js";
import { createComposerFeature, type ComposerFeatureOptions } from "../../../web-ui/app/controllers/composer-feature.js";
import { createComposerWorkspaceController } from "../../../web-ui/app/controllers/composer-workspace-controller.js";
import { createHomeComposerFeature } from "../../../web-ui/app/controllers/home-composer-feature.js";
// @ts-expect-error Production browser navigation.
import { createHomeConversationActivation } from "../../../web-ui/app/controllers/home-conversation-activation.js";
import { createSessionComposerQueue } from "../../../web-ui/app/lib/session-composer-queue.js";

export function createComposerProductionHarness(options: Pick<ComposerFeatureOptions, "getSubmissionBlock" | "onSubmissionBlocked" | "isComposerAvailable"> = {}) {
  const document = { createElement: (tag: string): any => element(tag) };
  function element(tag: string): any {
    const node = Object.assign(new ContextElement(tag), {
      ownerDocument: document, value: "", scrollHeight: 48, innerHTML: "", nextSibling: null, focus: vi.fn(),
    });
    Object.assign(node.style, { height: "" });
    return Object.assign(node, { insertBefore: vi.fn((child: ContextElement) => node.appendChild(child)) });
  }
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  let environmentId = "dev";
  let nextSessionId = 0;
  const state = {
    currentSessionId: "existing-chat", activeRequestId: "existing-request", sessionViewVersion: 0,
    agentMode: "reasoning", messages: [{ id: "existing-answer", role: "assistant", text: "Working" }],
  };
  const chatHost = element("div");
  const homeHost = element("div");
  const homeSetupHost = element("div");
  const form = element("form");
  const guide = element("div");
  chatHost.append(form, guide);
  const dom = { composerForm: form, runtimeSetupGuide: guide, composerInput: element("textarea"),
    attachmentButton: element("button"), attachmentPreview: element("div") };
  const getEnvironmentId = () => environmentId;
  const onSessionCreated = vi.fn();
  const workspace = createComposerWorkspaceController({ state, dom, homeComposerHost: homeHost,
    homeSetupHost, selectedEnvironmentId: getEnvironmentId, onSessionCreated,
    createSessionId: () => `home-session-${++nextSessionId}` });
  const client = {
    attachmentPreviewUrl: vi.fn(() => "/preview"), deleteAttachment: vi.fn(async () => {}),
    uploadAttachment: vi.fn(async (input: { sessionId: string }) => ({ id: "home-file",
      storageRef: `${input.sessionId}/home-file`, mimeType: "text/plain" })),
    postChatMessage: vi.fn(async (_input: Record<string, unknown>) => "new-request"),
    stopChatRequest: vi.fn(async (_scope: unknown) => ({ accepted: true })),
  };
  const composerActions = { primaryAction: vi.fn<() => "send" | "send_next" | "steer">(() => "send"), render: vi.fn() };
  const onControlEvent = vi.fn();
  const setMessageStatus = vi.fn();
  const storage = new Map<string, string>();
  const sessionQueue = createSessionComposerQueue({ ownerId: "test-window", storage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
  const session = {
    ensureSession: () => state.currentSessionId || (state.currentSessionId = "created-chat"),
    appendLocalUserMessage: vi.fn(({ text }: { text: string }) => {
      state.messages.push({ id: "user", role: "user", text });
      return vi.fn();
    }),
    activateRequestForScope: vi.fn((scope: { environmentId: string; sessionId: string }, requestId: string) => {
      if (scope.environmentId === environmentId && scope.sessionId === state.currentSessionId) state.activeRequestId = requestId;
    }),
    clearCurrentSessionView() { state.currentSessionId = ""; state.activeRequestId = ""; state.messages = []; },
    subscribeSession: vi.fn(),
  };
  const prepareWorkspaceActivation = vi.fn(() => () => { workspace.setWorkspace("chat"); return true; });
  const shell = { showToast: vi.fn(), navigationRevision: () => 0, prepareWorkspaceActivation };
  const steer = vi.fn(async (_text: string, _captured: unknown) => {});
  const composer = createComposerFeature({ state, dom: workspace.chatDom, shell, client, sessionQueue,
    conversationSession: session, conversationView: { reset: vi.fn() }, getEnvironmentId,
    getDraft: workspace.chatView.current, ensureSession: session.ensureSession, drafts: workspace.drafts,
    getSettings: () => ({ agentMode: "reasoning", toolPermissionMode: "ask", modelPreference: { profileId: "selected-model" } }),
    steer, composerActions, selectedModelSupportsImageInput: () => true, isComposerAvailable: () => true,
    getSubmissionBlock: () => null, onSubmissionBlocked: vi.fn(), isVisible: workspace.isChatVisible,
    renderSessions: vi.fn(), renderMessages: vi.fn(), applyConversationChrome: vi.fn(),
    setMessageStatus, recordControlEvent: onControlEvent, confirmReview: () => true, ...options });
  const saveSessionIdForEnvironment = vi.fn();
  const activateHomeSession = vi.fn(createHomeConversationActivation({ state, shell, conversationSession: session,
    composerQueue: composer.queue, preferences: { saveSessionIdForEnvironment }, selectedEnvironmentId: getEnvironmentId,
    renderSessions: vi.fn(), renderMessages: vi.fn(), applyModelSelection: vi.fn(), setCurrentTitle: vi.fn(),
    updateComposerSendState: () => workspace.syncChatDraft() }));
  const feature = createHomeComposerFeature({ workspace, composer, selectedModelSupportsImageInput: () => true,
    activateHomeSession });
  workspace.chatDraft().text = "Existing chat draft";
  workspace.chatDraft().attachments = [{ id: "chat-file", storageRef: "existing-chat/chat-file", mimeType: "text/plain",
    sessionId: "existing-chat", environment: "dev" }];
  return {
    state, dom, chatHost, homeHost, homeSetupHost, workspace, feature, composer, client,
    composerActions, onControlEvent, onSessionCreated, setMessageStatus, sessionQueue, session, steer,
    chatAttachments: composer.attachments, queue: composer.queue, activateHomeSession, prepareWorkspaceActivation,
    saveSessionIdForEnvironment,
    type(text: string) { dom.composerInput.value = text; dom.composerInput.dispatch("input"); },
    setEnvironmentId(value: string) { environmentId = value; workspace.syncChatDraft(); },
    switchSession(value: string) { state.currentSessionId = value; workspace.syncChatDraft(); },
    enqueue(text: string) { return sessionQueue.enqueue(workspace.chatDraft().scope, {
      text, attachments: workspace.chatDraft().attachments, waitForRequestId: state.activeRequestId,
      agentMode: "reasoning", toolPermissionMode: "ask", modelPreference: { profileId: "selected-model" },
    }); },
  };
}
