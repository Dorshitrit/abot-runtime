import { vi } from "vitest";

import { createRealtimeEventController } from "../../../web-ui/app/controllers/realtime-event-controller.js";

export function createRealtimeContextHarness() {
  const assistant = {
    id: "assistant-1",
    role: "assistant",
    requestId: "request-1",
    text: "",
    streaming: true,
  };
  const state = {
    activeRequestId: "request-1",
    currentSessionId: "session-1",
    contextWindowByRequest: new Map<string, Record<string, unknown>>(),
    taskProgressByRequest: new Map(),
    lastSeqByRequest: new Map(),
    events: [] as Array<Record<string, unknown>>,
  };
  const renderContextWindow = vi.fn(() =>
    state.contextWindowByRequest.get("request-1"),
  );
  const renderActivityStatus = vi.fn(() => ({
    contextWindow: state.contextWindowByRequest.get("request-1"),
    event: { ...state.events[state.events.length - 1] },
    streaming: assistant.streaming,
  }));
  const renderMessages = vi.fn();
  const scheduleMessageRender = vi.fn();
  const shouldAcceptMessage = vi.fn(() => true);
  const controller = createRealtimeEventController({
    state,
    shell: { showToast: vi.fn() },
    selectedEnvironmentId: () => "environment-1",
    handleSteerAcknowledgement: () => false,
    shouldAcceptMessage,
    applySessionReadState: vi.fn(),
    activeAssistantForRequest: () => assistant,
    addOrMergeMessage: vi.fn(),
    normalizeChatMessage: vi.fn(),
    renderMessages,
    renderContextWindow,
    renderActivityStatus,
    scheduleMessageRender,
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
    controller,
    renderMessages,
    renderContextWindow,
    renderActivityStatus,
    scheduleMessageRender,
    shouldAcceptMessage,
  };
}
