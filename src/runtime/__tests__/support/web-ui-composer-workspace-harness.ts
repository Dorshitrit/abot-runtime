import { vi } from "vitest";

import { createComposerAttachmentsController } from "../../../web-ui/app/controllers/composer-attachments-controller.js";
import { createComposerWorkspaceController } from "../../../web-ui/app/controllers/composer-workspace-controller.js";
import { createHomeComposerFeature } from "../../../web-ui/app/controllers/home-composer-feature.js";
import { createComposerQueueController } from "../../../web-ui/app/controllers/composer-queue-controller.js";
import { createSessionComposerQueue } from "../../../web-ui/app/lib/session-composer-queue.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createChatRequestController } from "../../../web-ui/app/controllers/chat-request-controller.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createHomeConversationActivation } from "../../../web-ui/app/controllers/home-conversation-activation.js";
import type { ComposerQueueState } from "../../../web-ui/app/controllers/composer-queue-controller.js";

export function createComposerWorkspaceHarness() {
  vi.stubGlobal("document", {
    createElement: () => ({
      className: "",
      innerHTML: "",
      querySelector: () => ({ addEventListener: vi.fn() }),
    }),
  });
  let environmentId = "dev";
  let nextSessionId = 0;
  const state = {
    currentSessionId: "existing-chat",
    activeRequestId: "existing-request",
    pendingAttachments: [{ id: "chat-file", mimeType: "text/plain" }],
    pendingAttachmentUploadCounts: new Map(),
    composerAttachmentGeneration: 0,
    composerSending: false,
    composerQueueDrainingScopes: new Set<string>(),
    composerQueueRecoveredReleaseTokens: new Set<string>(),
    activeComposerQueueRecovery: null,
    agentMode: "reasoning",
    messages: [{ id: "existing-answer", role: "assistant", text: "Working" }],
  } satisfies ComposerQueueState & Record<string, unknown>;
  const chatHost = {
    insertBefore: vi.fn((form: { parentElement: unknown }) => {
      form.parentElement = chatHost;
    }),
  };
  const homeHost = {
    appendChild: vi.fn((form: { parentElement: unknown }) => {
      form.parentElement = homeHost;
    }),
  };
  const homeSetupHost = {
    appendChild: vi.fn((guide: { parentElement: unknown }) => {
      guide.parentElement = homeSetupHost;
    }),
  };
  const runtimeSetupGuide = {
    parentElement: chatHost, nextSibling: null,
  } as unknown as HTMLElement;
  const nextSibling = { parentElement: chatHost };
  const composerForm = {
    parentElement: chatHost,
    nextSibling,
  } as unknown as HTMLElement;
  const dom = {
    composerForm,
    runtimeSetupGuide,
    composerInput: {
      value: "Existing chat draft",
      scrollHeight: 48,
      style: { height: "" },
      focus: vi.fn(),
    },
    attachmentButton: { disabled: false, title: "" },
    attachmentPreview: { innerHTML: "", appendChild: vi.fn() },
  };
  const selectedEnvironmentId = () => environmentId;
  const workspace = createComposerWorkspaceController({
    state,
    dom,
    homeComposerHost: homeHost as unknown as HTMLElement,
    homeSetupHost: homeSetupHost as unknown as HTMLElement,
    selectedEnvironmentId,
    createSessionId: () => `home-session-${++nextSessionId}`,
  });
  const client = {
    attachmentPreviewUrl: vi.fn(() => "/preview"),
    deleteAttachment: vi.fn(async () => {}),
    uploadAttachment: vi.fn(async (input: { sessionId: string }) => ({
      id: "home-file",
      storageRef: `${input.sessionId}/home-file`,
      mimeType: "text/plain",
    })),
    postChatMessage: vi.fn(async (_input: Record<string, unknown>) => "new-request"),
  };
  const shell = { showToast: vi.fn() };
  const composerActions = {
    primaryAction: () => "steer",
    render: vi.fn(),
  };
  const onControlEvent = vi.fn();
  let feature: ReturnType<typeof createHomeComposerFeature>;
  const chatAttachments = createComposerAttachmentsController({
    state,
    dom: workspace.chatDom,
    shell,
    client,
    selectedEnvironmentId,
    selectedModelSupportsImageInput: () => true,
    ensureSession: vi.fn(),
    onSendStateChange: () => feature?.submit.updateSendState(),
    onControlEvent,
    isComposerVisible: workspace.isChatVisible,
  });
  const scope = () => ({
    environmentId: selectedEnvironmentId(),
    sessionId: state.currentSessionId,
  });
  const isCurrentScope = (candidate: ReturnType<typeof scope>) =>
    candidate.sessionId === state.currentSessionId &&
    candidate.environmentId === selectedEnvironmentId();
  const storage = new Map<string, string>();
  const sessionQueue = createSessionComposerQueue({
    storage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  const chatRequests = createChatRequestController({
    state,
    client,
    sessionQueue,
    conversationView: { reset: vi.fn() },
    conversationSession: {
      ensureSession: vi.fn(),
      appendLocalUserMessage: ({ text }: { text: string }) => {
        state.messages.push({ id: "new-user", role: "user", text });
      },
      activateRequestForScope: (_scope: unknown, requestId: string) => {
        state.activeRequestId = requestId;
      },
    },
    attachments: chatAttachments,
    currentComposerScope: scope,
    isCurrentComposerScope: isCurrentScope,
    rememberModelSelection: vi.fn(),
    applyConversationChrome: vi.fn(),
    renderSessions: vi.fn(),
    renderAttachments: chatAttachments.render,
    getToolPermissionMode: () => "ask",
    getModelPreference: () => ({ profileId: "selected-model" }),
    clearQueueRecovery: vi.fn(),
    reportQueueFailure: vi.fn(),
  });
  const prepareWorkspaceActivation = vi.fn(() => () => {
    feature.setWorkspace("chat");
    return true;
  });
  const saveSessionIdForEnvironment = vi.fn();
  const activateHomeSession = vi.fn(createHomeConversationActivation({
    state,
    shell: { prepareWorkspaceActivation },
    conversationSession: {
      clearCurrentSessionView() {
        state.currentSessionId = "";
        state.activeRequestId = "";
        state.messages = [];
        chatAttachments.clear();
      },
      ensureSession: () => state.currentSessionId,
      subscribeSession: vi.fn(),
    },
    composerQueue: {
      suspendRecoveryForNavigation: () => queue.suspendRecoveryForNavigation(),
    },
    preferences: { saveSessionIdForEnvironment },
    applyModelSelection: vi.fn(),
    setCurrentTitle: vi.fn(),
    updateComposerSendState: () => workspace.syncChatDraft(),
    selectedEnvironmentId,
    renderSessions: vi.fn(),
    renderMessages: vi.fn(),
  }));
  feature = createHomeComposerFeature({
    workspace,
    shell,
    client,
    composerActions,
    selectedEnvironmentId,
    selectedModelSupportsImageInput: () => true,
    onControlEvent,
    onStateChange: () => feature?.submit.updateSendState(),
    activateHomeSession,
    sendMessage: (text) => chatRequests.sendMessage(text),
  });
  const queue = createComposerQueueController({
    state,
    dom: workspace.chatDom,
    queue: sessionQueue,
    selectedEnvironmentId,
    getToolPermissionMode: () => "ask",
    getModelPreference: () => ({ profileId: "selected-model" }),
    rememberModelSelection: vi.fn(),
    attachments: chatAttachments,
    updateSendState: () => feature.submit.updateSendState(),
    postChatMessage: async () => {
      throw new Error("Transport unavailable");
    },
    appendLocalUserMessage: vi.fn(),
    activateRequestForScope: vi.fn(),
    renderMessages: vi.fn(),
    setMessageStatus: vi.fn(),
    recordControlEvent: onControlEvent,
    resizeComposer: vi.fn(),
  });
  return {
    state, dom, chatHost, homeHost, homeSetupHost, nextSibling,
    workspace, feature, client, composerActions,
    chatAttachments, queue, sessionQueue, activateHomeSession,
    prepareWorkspaceActivation, saveSessionIdForEnvironment,
    onControlEvent,
    setEnvironmentId(value: string) {
      environmentId = value;
    },
  };
}
