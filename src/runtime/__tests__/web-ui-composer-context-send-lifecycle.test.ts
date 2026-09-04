import { describe, expect, test, vi } from "vitest";

import {
  buildComposerContextWindowModel,
  createComposerContextWindow,
} from "../../web-ui/app/components/composer-context-window.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createChatRequestController } from "../../web-ui/app/controllers/chat-request-controller.js";
import {
  createConversationSessionController,
  type ConversationSessionMessage,
  type ConversationSessionScope,
} from "../../web-ui/app/controllers/conversation-session-controller.js";
import { createRealtimeEventController } from "../../web-ui/app/controllers/realtime-event-controller.js";
import { createComposerContextDom } from "./support/composer-context-window-dom.js";

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
    markSessionRead: vi.fn(async () => ({ readState: {} })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    loadSession: vi.fn(async () => ({ messages: [], requests: [] })),
    fetchRequestEvents: vi.fn(async () => []),
  };
  const selectedEnvironmentId = () => "dev";
  const currentComposerScope = () => ({
    environmentId: selectedEnvironmentId(),
    sessionId: state.currentSessionId,
  });
  const isCurrentComposerScope = (scope: ConversationSessionScope) =>
    scope.environmentId === selectedEnvironmentId() &&
    scope.sessionId === state.currentSessionId;
  const conversationView = { reset: vi.fn(() => indicator.reset()) };
  const sessionQueue = {
    peek: vi.fn(() => null),
    rebindBlocked: vi.fn(() => false),
  };
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
    clearPendingAttachments: vi.fn(),
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
    forgetThinkingDisclosure: vi.fn(),
    markCurrentSessionReadSoon: vi.fn(),
    applySessionTitleUpdate: vi.fn(),
    setMessageActivityStatus: vi.fn(),
    updateComposerSendState: vi.fn(),
    drainQueuedComposerMessage: vi.fn(),
    loadSessions: vi.fn(),
  });
  const chatRequest = createChatRequestController({
    state,
    client,
    sessionQueue,
    conversationView,
    conversationSession,
    attachments: { invalidateCompletions: vi.fn() },
    currentComposerScope,
    isCurrentComposerScope,
    rememberModelSelection: vi.fn(),
    applyConversationChrome: vi.fn(),
    renderSessions: vi.fn(),
    renderAttachments: vi.fn(),
    getToolPermissionMode: () => "full_access",
    getModelPreference: () => ({ profileId: "local", scope: "all" }),
    clearQueueRecovery: vi.fn(),
    reportQueueFailure: vi.fn(),
  });
  realtime.recordEvent(contextSnapshot("completed", 31));
  return {
    ...dom,
    state,
    client,
    pendingRequest,
    chatRequest,
    conversationSession,
    realtime,
    renderMessages,
  };
}

describe("composer context across chat submission", () => {
  test("hides completed-request context throughout pending send until the new request has metrics", async () => {
    const harness = createSendLifecycleHarness();
    const { state, container, chatRequest, pendingRequest, realtime } = harness;
    const completedMetrics = state.contextWindowByRequest.get("completed");
    expect(container.hidden).toBe(false);
    expect(container.dataset.requestId).toBe("completed");
    expect(container.textContent).toContain("31%");
    harness.renderMessages.mockClear();

    const sending = chatRequest.sendMessage("Next question");

    expect(harness.client.postChatMessage).toHaveBeenCalledOnce();
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
