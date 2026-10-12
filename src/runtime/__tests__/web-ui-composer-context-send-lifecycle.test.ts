import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buildComposerContextWindowModel,
  createComposerContextWindow,
} from "../../web-ui/app/components/composer-context-window.js";
import { createComposerFeature } from "../../web-ui/app/controllers/composer-feature.js";
import { createComposerWorkspaceController } from "../../web-ui/app/controllers/composer-workspace-controller.js";
import { createSessionComposerQueue } from "../../web-ui/app/lib/session-composer-queue.js";
afterEach(() => vi.unstubAllGlobals());
import {
  createConversationSessionController,
  type ConversationSessionMessage,
  type ConversationSessionScope,
} from "../../web-ui/app/controllers/conversation-session-controller.js";
import { createRealtimeEventController } from "../../web-ui/app/controllers/realtime-event-controller.js";
import { ContextElement, createComposerContextDom } from "./support/composer-context-window-dom.js";

function deferredRequestId() {
  let resolve!: (requestId: string) => void;
  const promise = new Promise<string>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function contextSnapshot(requestId: string, usedContextPercent: number) {
  return {
    type: "event",
    name: "context.window.snapshot",
    requestId,
    invocationId: `invocation-${requestId}`,
    modelStep: "worker.decision",
    profileId: "local",
    measurement: "estimated",
    source: "runtime_token_estimator",
    admissionOutcome: "accepted",
    contextWindowTokens: 10_000,
    estimatedInputTokens: usedContextPercent * 100,
    remainingContextTokens: (100 - usedContextPercent) * 100,
    usedContextPercent,
    remainingContextPercent: 100 - usedContextPercent,
    compactionTriggerPercent: 70,
    outputReserveTokens: 1_000,
    safetyReserveTokens: 100,
    attachmentReserveTokens: 50,
    formatReserveTokens: 20,
  };
}

function createSendLifecycleHarness() {
  const dom = createComposerContextDom();
  const indicator = createComposerContextWindow({
    container: dom.container as unknown as HTMLElement,
    documentRoot: dom.documentRoot as unknown as Document,
  });
  const state = {
    currentSessionId: "session-1",
    activeRequestId: "",
    sessionViewVersion: 0,
    agentMode: "reasoning",
    pendingAttachments: [] as unknown[],
    messages: [
      {
        id: "assistant-completed",
        role: "assistant",
        text: "Previous answer",
        requestId: "completed",
        streaming: false,
      },
    ] as ConversationSessionMessage[],
    events: [] as Array<Record<string, unknown>>,
    taskProgressByRequest: new Map<string, Record<string, unknown>>(),
    contextWindowByRequest: new Map<string, Record<string, unknown>>(),
    submittedToolApprovalIds: new Set<string>(),
    requestMessages: new Map([["completed", "assistant-completed"]]),
    lastSeqByRequest: new Map<string, number>(),
    sessions: [] as Array<Record<string, unknown>>,
  };
  const renderMessages = vi.fn(() => {
    indicator.render(
      buildComposerContextWindowModel({
        messages: state.messages,
        activeRequestId: state.activeRequestId,
        getActivityForMessage: (message) => ({
          contextWindow: state.contextWindowByRequest.get(
            String(message.requestId),
          ),
        }),
      }),
    );
  });
  const pendingRequest = deferredRequestId();
  const client = {
    postChatMessage: vi.fn(() => pendingRequest.promise),
    stopChatRequest: vi.fn(async () => ({ accepted: true })),
    attachmentPreviewUrl: vi.fn(() => ""),
    deleteAttachment: vi.fn(async () => {}),
    uploadAttachment: vi.fn(async () => ({ id: "file" })),
    markSessionRead: vi.fn(async () => ({ readState: {} })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    loadSession: vi.fn(async () => ({ messages: [], requests: [] })),
    fetchRequestEvents: vi.fn(async () => []),
  };
  const selectedEnvironmentId = () => "dev";
  const isCurrentComposerScope = (scope: ConversationSessionScope) =>
    scope.environmentId === selectedEnvironmentId() &&
    scope.sessionId === state.currentSessionId;
  const conversationView = { reset: vi.fn(() => indicator.reset()) };
  const storage = new Map<string, string>();
  const sessionQueue = createSessionComposerQueue({ storage: { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value) } });
  const conversationSession = createConversationSessionController({
    state,
    dom: {
      sessionTitle: { textContent: "" },
      sessionsList: { innerHTML: "" },
    },
    client,
    preferences: {
      sessionIdForEnvironment: () => "session-1",
      saveSessionIdForEnvironment: vi.fn(),
    },
    sessions: {
      titleOf: () => "Conversation",
      byId: () => ({ id: "session-1" }),
      setCurrentTitle: vi.fn(),
      applyTitle: vi.fn(),
      applyReadState: vi.fn(),
    },
    sessionQueue,
    conversationView,
    selectedEnvironmentId,
    applyConversationChrome: vi.fn(),
    applyModelSelection: vi.fn(),
    renderSessions: vi.fn(),
    renderMessages,
    updateComposerSendState: vi.fn(),
    setMessageStatus: vi.fn(),
    sendRealtime: vi.fn(() => true),
    handleRealtimeMessage: vi.fn(),
    recordEvent: vi.fn(),
    recordControlEvent: vi.fn(),
    reportQueueFailure: vi.fn(),
    drainQueuedMessage: vi.fn(),
    suspendQueueRecovery: () => true,
    recoverBlockedQueue: vi.fn(),
    isCurrentComposerScope,
    scheduleTask: vi.fn(),
  });
  const realtime = createRealtimeEventController({
    state,
    shell: { showToast: vi.fn() },
    selectedEnvironmentId,
    handleSteerAcknowledgement: () => false,
    shouldAcceptMessage: () => true,
    applySessionReadState: vi.fn(),
    activeAssistantForRequest: conversationSession.activeAssistantForRequest,
    addOrMergeMessage: conversationSession.addOrMergeMessage,
    normalizeChatMessage: conversationSession.normalizeMessage,
    renderMessages,
    renderContextWindow: renderMessages,
    scheduleMessageRender: vi.fn(),
    scheduleThinkingRender: vi.fn(),
    cancelScheduledMessageRender: vi.fn(),
    cancelScheduledThinkingRender: vi.fn(),
    markCurrentSessionReadSoon: vi.fn(),
    applySessionTitleUpdate: vi.fn(),
    setMessageActivityStatus: vi.fn(),
    updateComposerSendState: vi.fn(),
    drainQueuedComposerMessage: vi.fn(),
    loadSessions: vi.fn(),
  });
  const createElement = (tag: string): any => Object.assign(new ContextElement(tag), {
    ownerDocument: dom.documentRoot, value: "", scrollHeight: 48, innerHTML: "", focus: vi.fn(),
  });
  const host: any = createElement("div");
  host.insertBefore = (child: ContextElement) => host.appendChild(child);
  const form = createElement("form");
  host.appendChild(form);
  const composerDom = { composerForm: form, composerInput: createElement("textarea"),
    attachmentButton: createElement("button"), attachmentPreview: createElement("div") };
  const workspace: any = createComposerWorkspaceController({ state, dom: composerDom,
    homeComposerHost: createElement("div"), selectedEnvironmentId });
  vi.stubGlobal("document", dom.documentRoot);
  const composer = createComposerFeature({ state, dom: workspace.chatDom, shell: { showToast: vi.fn() }, client,
    sessionQueue, conversationSession, conversationView, getEnvironmentId: selectedEnvironmentId,
    getDraft: workspace.chatView.current, ensureSession: () => state.currentSessionId, drafts: workspace.drafts,
    getSettings: () => ({ agentMode: "reasoning", toolPermissionMode: "ask", modelPreference: { profileId: "local" } }),
    steer: vi.fn(), composerActions: { primaryAction: () => "send", render: vi.fn() },
    selectedModelSupportsImageInput: () => true, isComposerAvailable: () => true,
    getSubmissionBlock: () => null, onSubmissionBlocked: vi.fn(), isVisible: () => true,
    renderSessions: vi.fn(), renderMessages, applyConversationChrome: vi.fn(), setMessageStatus: vi.fn(), recordControlEvent: vi.fn(),
  });
  realtime.recordEvent(contextSnapshot("completed", 31));
  return {
    ...dom,
    state,
    client,
    pendingRequest,
    composer, composerDom,
    conversationSession,
    realtime,
    renderMessages,
  };
}

describe("composer context across chat submission", () => {
  test("hides completed-request context throughout pending send until the new request has metrics", async () => {
    const harness = createSendLifecycleHarness();
    const { state, container, composer, pendingRequest, realtime } = harness;
    const completedMetrics = state.contextWindowByRequest.get("completed");
    expect(container.hidden).toBe(false);
    expect(container.dataset.requestId).toBe("completed");
    expect(container.textContent).toContain("31%");
    harness.renderMessages.mockClear();

    harness.composerDom.composerInput.value = "Next question";
    const sending = composer.submit.dispatch();

    await vi.waitFor(() => expect(harness.client.postChatMessage).toHaveBeenCalledOnce());
    expect(harness.renderMessages).toHaveBeenCalledOnce();
    expect(state.activeRequestId).toBe("");
    expect(state.messages.at(-1)).toMatchObject({
      role: "user",
      text: "Next question",
      requestId: "",
    });
    expect(container.hidden).toBe(true);
    expect(container.dataset.requestId).toBe("");
    expect(container.textContent).not.toContain("31%");
    expect(state.contextWindowByRequest.get("completed")).toBe(
      completedMetrics,
    );

    pendingRequest.resolve("new-request");
    await sending;

    expect(state.activeRequestId).toBe("new-request");
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant",
      requestId: "new-request",
      streaming: true,
    });
    expect(state.contextWindowByRequest.has("new-request")).toBe(false);
    expect(container.hidden).toBe(true);
    expect(container.dataset.requestId).toBe("");

    realtime.recordEvent(contextSnapshot("new-request", 12));

    expect(container.hidden).toBe(false);
    expect(container.dataset.requestId).toBe("new-request");
    expect(container.textContent).toContain("12%");
    expect(container.textContent).not.toContain("31%");
    expect(state.contextWindowByRequest.get("completed")).toBe(
      completedMetrics,
    );
    expect([...state.contextWindowByRequest.keys()]).toEqual([
      "completed",
      "new-request",
    ]);
  });

  test("keeps the active request authoritative when a steering user message is appended", () => {
    const harness = createSendLifecycleHarness();
    const { state, conversationSession, realtime, container } = harness;
    conversationSession.activateRequestForScope(
      { environmentId: "dev", sessionId: "session-1" },
      "active-request",
    );
    realtime.recordEvent(contextSnapshot("active-request", 45));
    expect(container.dataset.requestId).toBe("active-request");

    conversationSession.appendLocalUserMessage({
      text: "Keep the answer brief",
      attachments: [],
      requestId: "active-request",
    });

    expect(state.messages.at(-1)?.role).toBe("user");
    expect(state.activeRequestId).toBe("active-request");
    expect(container.hidden).toBe(false);
    expect(container.dataset.requestId).toBe("active-request");
    expect(container.textContent).toContain("45%");
    expect(state.contextWindowByRequest.has("completed")).toBe(true);
  });
});
