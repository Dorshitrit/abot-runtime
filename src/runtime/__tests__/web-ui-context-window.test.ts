import { describe, expect, test } from "vitest";

import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { createRealtimeContextHarness } from "./support/realtime-context-harness.js";

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

  test("refreshes metrics and activity after low-value events without message rendering", () => {
    const {
      state,
      controller,
      renderContextWindow,
      renderActivityStatus,
      renderMessages,
      scheduleMessageRender,
    } = createRealtimeContextHarness();
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
    expect(renderActivityStatus).toHaveBeenCalledOnce();
    expect(
      renderActivityStatus.mock.results[0]?.value.contextWindow,
    ).toMatchObject({
      snapshot: { estimatedInputTokens: 100, usedContextPercent: 10 },
    });
    expect(renderMessages).not.toHaveBeenCalled();
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
    expect(renderActivityStatus).toHaveBeenCalledTimes(2);
    expect(
      renderActivityStatus.mock.results[1]?.value.contextWindow,
    ).toMatchObject({
      providerUsage: { inputTokens: 98, outputTokens: 12 },
    });
    expect(renderMessages).not.toHaveBeenCalled();
    expect(scheduleMessageRender).not.toHaveBeenCalled();
  });

  test("does not refresh from invalid snapshots or rejected session messages", () => {
    const {
      state,
      controller,
      renderContextWindow,
      renderActivityStatus,
      shouldAcceptMessage,
    } = createRealtimeContextHarness();
    const snapshot = {
      type: "event",
      name: "context.window.snapshot",
      requestId: "request-1",
      contextWindowTokens: 1_000,
      estimatedInputTokens: 100,
      usedContextPercent: 10,
    };
    controller.recordEvent({ ...snapshot, contextWindowTokens: 0 });
    shouldAcceptMessage.mockReturnValue(false);
    controller.handle({ ...snapshot, sessionId: "old-session" });

    expect(renderContextWindow).not.toHaveBeenCalled();
    expect(renderActivityStatus).not.toHaveBeenCalled();
    expect(state.contextWindowByRequest.size).toBe(0);
  });

  test("refreshes activity after ordinary events are appended or merged", () => {
    const { controller, renderActivityStatus, renderContextWindow } =
      createRealtimeContextHarness();
    const event = {
      type: "event",
      name: "runtime.state",
      requestId: "request-1",
      status: "working",
    };
    controller.recordEvent(event);
    controller.recordEvent(event);

    expect(renderActivityStatus).toHaveBeenCalledTimes(2);
    expect(renderActivityStatus.mock.results[0]?.value.event).toMatchObject({
      eventName: "runtime.state",
      count: 1,
    });
    expect(renderActivityStatus.mock.results[1]?.value.event).toMatchObject({
      eventName: "runtime.state",
      count: 2,
    });
    expect(renderContextWindow).not.toHaveBeenCalled();
  });

  test.each(["eventSequence", "seqNo"] as const)(
    "retains the latest phase when older or duplicate %s snapshots replay",
    (sequenceField) => {
      const { controller, state, renderActivityStatus, renderContextWindow } =
        createRealtimeContextHarness();
      const snapshot = {
        type: "event",
        name: "context.window.snapshot",
        requestId: "request-1",
        modelStep: "worker.decision",
        admissionOutcome: "accepted",
        contextWindowTokens: 1_000,
        estimatedInputTokens: 100,
        usedContextPercent: 10,
      };
      controller.recordEvent({ ...snapshot, [sequenceField]: 10 });
      controller.recordEvent({
        ...snapshot,
        modelStep: "tool_payload.raw",
        [sequenceField]: 9,
      });
      controller.recordEvent({
        ...snapshot,
        modelStep: "tool_payload.raw",
        [sequenceField]: 10,
      });

      expect(
        state.contextWindowByRequest.get("request-1")?.snapshot,
      ).toMatchObject({
        modelStep: "worker.decision",
        [sequenceField]: 10,
      });
      expect(renderActivityStatus).toHaveBeenCalledOnce();
      expect(renderContextWindow).toHaveBeenCalledOnce();

      controller.recordEvent({
        ...snapshot,
        modelStep: "supervisor.response",
        [sequenceField]: 11,
      });
      expect(
        state.contextWindowByRequest.get("request-1")?.snapshot,
      ).toMatchObject({
        modelStep: "supervisor.response",
        [sequenceField]: 11,
      });
      expect(renderActivityStatus).toHaveBeenCalledTimes(2);
    },
  );

  test("preserves both sequence domains and rejected admission metrics", () => {
    const { controller, state, renderActivityStatus } =
      createRealtimeContextHarness();
    controller.recordEvent({
      type: "event",
      name: "context.window.snapshot",
      requestId: "request-1",
      eventSequence: 30,
      seqNo: 45,
      modelStep: "worker.decision",
      admissionOutcome: "rejected",
      contextWindowTokens: 1_000,
      estimatedInputTokens: 1_100,
      usedContextPercent: 110,
    });

    expect(
      state.contextWindowByRequest.get("request-1")?.snapshot,
    ).toMatchObject({
      eventSequence: 30,
      seqNo: 45,
      admissionOutcome: "rejected",
      estimatedInputTokens: 1_100,
    });
    expect(renderActivityStatus).toHaveBeenCalledOnce();
  });

  test.each(["completed", "failed"])(
    "settles streaming before refreshing activity for %s requests",
    (type) => {
      const { controller, renderActivityStatus } =
        createRealtimeContextHarness();
      controller.handle({ type, requestId: "request-1" });

      expect(renderActivityStatus).toHaveBeenCalledOnce();
      expect(renderActivityStatus.mock.results[0]?.value.streaming).toBe(false);
    },
  );
});
