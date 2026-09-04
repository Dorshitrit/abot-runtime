import { vi } from "vitest";

import {
  createConversationSessionController,
  type ConversationSessionState,
} from "../../../web-ui/app/controllers/conversation-session-controller.js";
import { createRealtimeEventController } from "../../../web-ui/app/controllers/realtime-event-controller.js";
import {
  buildComposerPlanModel,
  type ComposerPlanModel,
} from "../../../web-ui/app/lib/composer-plan-model.js";

export function createPlanLifecycleHarness(
  sessionPayload: Record<string, unknown> = {},
  replayEvents: unknown[] = [],
) {
  const state: ConversationSessionState = {
    currentSessionId: "session-1",
    activeRequestId: "request-1",
    sessionViewVersion: 0,
    messages: [
      {
        id: "user-1",
        role: "user",
        text: "Prepare release",
        requestId: "request-1",
      },
      {
        id: "assistant-1",
        role: "assistant",
        text: "",
        requestId: "request-1",
        streaming: true,
      },
    ],
    events: [],
    taskProgressByRequest: new Map(),
    contextWindowByRequest: new Map(),
    submittedToolApprovalIds: new Set(),
    requestMessages: new Map([["request-1", "assistant-1"]]),
    lastSeqByRequest: new Map(),
    sessions: [],
  };
  let renderedPlan: ComposerPlanModel | null = null;
  const renderMessages = vi.fn(() => {
    renderedPlan = buildComposerPlanModel({
      messages: state.messages,
      activeRequestId: state.activeRequestId,
      getActivityForMessage: (message) => ({
        taskProgress: state.taskProgressByRequest.get(
          String(message.requestId),
        ),
      }),
    });
  });
  const client = {
    markSessionRead: vi.fn(async () => ({ readState: {} })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    loadSession: vi.fn(async () => sessionPayload),
    fetchRequestEvents: vi.fn(async () => replayEvents),
  };
  const selectedEnvironmentId = () => "dev";
  const sendRealtime = vi.fn(() => true);
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
    sessionQueue: { peek: () => null, rebindBlocked: vi.fn() },
    conversationView: {
      reset: () => {
        renderedPlan = null;
      },
    },
    selectedEnvironmentId,
    clearPendingAttachments: vi.fn(),
    applyConversationChrome: vi.fn(),
    applyModelSelection: vi.fn(),
    renderSessions: vi.fn(),
    renderMessages,
    updateComposerSendState: vi.fn(),
    setMessageStatus: vi.fn(),
    sendRealtime,
    handleRealtimeMessage: (message) => realtime.handle(message),
    recordEvent: (event) => realtime.recordEvent(event),
    recordControlEvent: (event) => realtime.recordControlEvent(event),
    reportQueueFailure: vi.fn(),
    drainQueuedMessage: vi.fn(),
    suspendQueueRecovery: () => true,
    recoverBlockedQueue: vi.fn(),
    isCurrentComposerScope: () => true,
    scheduleTask: vi.fn(),
  });
  const realtime = createRealtimeEventController({
    state,
    shell: { showToast: vi.fn() },
    selectedEnvironmentId,
    handleSteerAcknowledgement: () => false,
    shouldAcceptMessage: conversationSession.shouldAcceptRealtimeMessage,
    applySessionReadState: vi.fn(),
    activeAssistantForRequest: conversationSession.activeAssistantForRequest,
    addOrMergeMessage: conversationSession.addOrMergeMessage,
    normalizeChatMessage: conversationSession.normalizeMessage,
    renderMessages,
    scheduleMessageRender: renderMessages,
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
  return {
    state,
    client,
    conversationSession,
    realtime,
    renderMessages,
    sendRealtime,
    plan: () => renderedPlan,
  };
}
