import { describe, expect, test, vi } from "vitest";

import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { createRealtimeEventController } from "../../web-ui/app/controllers/realtime-event-controller.js";

function createRealtimeContextHarness() {
  const state = {
    activeRequestId: "request-1",
    currentSessionId: "session-1",
    contextWindowByRequest: new Map<string, Record<string, unknown>>(),
    taskProgressByRequest: new Map(),
    lastSeqByRequest: new Map(),
    events: [],
  };
  const renderContextWindow = vi.fn(() =>
    state.contextWindowByRequest.get("request-1"),
  );
  const scheduleMessageRender = vi.fn();
  const shouldAcceptMessage = vi.fn(() => true);
  const controller = createRealtimeEventController({
    state,
    shell: { showToast: vi.fn() },
    selectedEnvironmentId: () => "environment-1",
    handleSteerAcknowledgement: () => false,
    shouldAcceptMessage,
    applySessionReadState: vi.fn(),
    activeAssistantForRequest: vi.fn(),
    addOrMergeMessage: vi.fn(),
    normalizeChatMessage: vi.fn(),
    renderMessages: vi.fn(),
    renderContextWindow,
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
    renderContextWindow,
    scheduleMessageRender,
    shouldAcceptMessage,
  };
}

describe("web ui context window projection", () => {
  test("replays the last invocation estimate, provider usage, and compaction delta", () => {
    const { state, controller, renderContextWindow } =
      createRealtimeContextHarness();

    controller.recordEvent({
      type: "event",
      name: "context.window.snapshot",
      requestId: "request-1",
      invocationId: "invocation-2",
      modelStep: "worker.decision",
      profileId: "gemma",
      provider: "ollama",
      model: "gemma-test",
      measurement: "estimated",
      source: "runtime_token_estimator",
      admissionOutcome: "accepted",
      contextWindowTokens: 32_768,
      estimatedInputTokens: 3_604,
      remainingContextTokens: 29_164,
      usedContextPercent: 11,
      remainingContextPercent: 89,
      compactionTriggerPercent: 70,
      outputReserveTokens: 4_096,
      safetyReserveTokens: 1_200,
      attachmentReserveTokens: 1_024,
      formatReserveTokens: 128,
    });
    controller.recordEvent({
      type: "event",
      name: "context.compaction.completed",
      requestId: "request-1",
      beforeUsedContextPercent: 81,
      afterUsedContextPercent: 11,
    });
    controller.recordEvent({
      type: "event",
      name: "context.window.provider_usage",
      requestId: "request-1",
      invocationId: "invocation-2",
      modelStep: "worker.decision",
      profileId: "gemma",
      source: "provider_reported",
      inputTokens: 3_590,
      outputTokens: 84,
      totalTokens: 3_674,
    });

    const contextWindow = state.contextWindowByRequest.get("request-1");
    const model = buildConversationActivityModel({
      requestId: "request-1",
      contextWindow,
    });

    expect(state.events).toEqual([
      expect.objectContaining({
        requestId: "request-1",
        eventName: "context.compaction.completed",
      }),
    ]);
    expect(model.contextWindow).toEqual(
      expect.objectContaining({
        invocationId: "invocation-2",
        modelStep: "worker.decision",
        profileId: "gemma",
        contextWindowTokens: 32_768,
        estimatedInputTokens: 3_604,
        usedContextPercent: 11,
        remainingContextPercent: 89,
        compaction: { beforePercent: 81, afterPercent: 11 },
        providerUsage: {
          inputTokens: 3_590,
          outputTokens: 84,
          totalTokens: 3_674,
          source: "provider_reported",
        },
      }),
    );
    expect(model.hasContent).toBe(false);
    expect(renderContextWindow).toHaveBeenCalledTimes(3);
  });

  test("does not attach provider usage from a different invocation", () => {
    const model = buildConversationActivityModel({
      requestId: "request-1",
      contextWindow: {
        requestId: "request-1",
        snapshot: {
          invocationId: "invocation-current",
          contextWindowTokens: 100,
          estimatedInputTokens: 20,
          usedContextPercent: 20,
        },
        providerUsage: {
          invocationId: "invocation-old",
          inputTokens: 90,
          outputTokens: 10,
          totalTokens: 100,
        },
      },
    });

    expect(model.contextWindow?.providerUsage).toBeNull();
  });

  test("refreshes composer metrics after low-value events without needing message rendering", () => {
    const { state, controller, renderContextWindow, scheduleMessageRender } =
      createRealtimeContextHarness();
    controller.recordEvent({
      type: "event",
      name: "context.window.snapshot",
      requestId: "request-1",
      invocationId: "invocation-1",
      contextWindowTokens: 1_000,
      estimatedInputTokens: 100,
      usedContextPercent: 10,
    });
    expect(renderContextWindow).toHaveBeenCalledOnce();
    expect(renderContextWindow.mock.results[0]?.value).toMatchObject({
      snapshot: { estimatedInputTokens: 100, usedContextPercent: 10 },
    });
    expect(scheduleMessageRender).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);

    controller.recordEvent({
      type: "event",
      name: "context.window.provider_usage",
      requestId: "request-1",
      invocationId: "invocation-1",
      inputTokens: 98,
      outputTokens: 12,
    });
    expect(renderContextWindow).toHaveBeenCalledTimes(2);
    expect(renderContextWindow.mock.results[1]?.value).toMatchObject({
      providerUsage: { inputTokens: 98, outputTokens: 12 },
    });
    expect(scheduleMessageRender).not.toHaveBeenCalled();
  });

  test("does not refresh from invalid snapshots, unrelated events, or rejected session messages", () => {
    const { state, controller, renderContextWindow, shouldAcceptMessage } =
      createRealtimeContextHarness();
    const snapshot = {
      type: "event",
      name: "context.window.snapshot",
      requestId: "request-1",
      contextWindowTokens: 1_000,
      estimatedInputTokens: 100,
      usedContextPercent: 10,
    };
    controller.recordEvent({ ...snapshot, contextWindowTokens: 0 });
    controller.recordEvent({
      type: "event",
      name: "tool.started",
      requestId: "request-1",
    });
    shouldAcceptMessage.mockReturnValue(false);
    controller.handle({ ...snapshot, sessionId: "old-session" });

    expect(renderContextWindow).not.toHaveBeenCalled();
    expect(state.contextWindowByRequest.size).toBe(0);
  });
});
