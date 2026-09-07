import { describe, expect, test } from "vitest";

import { buildConversationStatus } from "../../web-ui/app/lib/conversation-status-model.js";
import { createRealtimeContextHarness } from "./support/realtime-context-harness.js";

describe("context window replay freshness", () => {
  test("keeps a completed model phase settled after delayed provider usage replay", () => {
    const { controller, state, renderActivityStatus } =
      createRealtimeContextHarness();
    controller.handle({
      type: "event",
      name: "context.window.snapshot",
      requestId: "request-1",
      eventSequence: 20,
      seqNo: 20,
      invocationId: "invocation-current",
      modelStep: "worker.decision",
      admissionOutcome: "accepted",
      contextWindowTokens: 1_000,
      estimatedInputTokens: 100,
      usedContextPercent: 10,
    });
    const usage = {
      type: "event",
      name: "context.window.provider_usage",
      requestId: "request-1",
      eventSequence: 21,
      seqNo: 21,
      invocationId: "invocation-current",
      inputTokens: 100,
    };
    controller.handle(usage);
    const completedStatus = buildConversationStatus({
      requestId: "request-1",
      streaming: true,
      contextWindow: state.contextWindowByRequest.get("request-1"),
    });
    controller.handle({
      ...usage,
      eventSequence: 19,
      seqNo: 22,
      invocationId: "invocation-previous",
    });
    controller.handle({ ...usage, seqNo: 23 });

    const contextWindow = state.contextWindowByRequest.get("request-1");
    expect(contextWindow?.providerUsage).toMatchObject({
      eventSequence: 21,
      seqNo: 21,
      invocationId: "invocation-current",
    });
    expect(completedStatus?.label).toBe("Working");
    expect(
      buildConversationStatus({
        requestId: "request-1",
        streaming: true,
        contextWindow,
      }),
    ).toEqual(completedStatus);
    expect(renderActivityStatus).toHaveBeenCalledTimes(2);
  });

  test.each(["completed", "failed"])(
    "does not reopen %s compaction when old lifecycle events replay",
    (phase) => {
      const { controller, state } = createRealtimeContextHarness();
      const terminal = {
        type: "event",
        name: `context.compaction.${phase}`,
        requestId: "request-1",
        eventSequence: 12,
        seqNo: 12,
        beforeUsedContextPercent: 90,
        afterUsedContextPercent: 10,
      };
      controller.handle(terminal);
      controller.handle({
        type: "event",
        name: "context.window.snapshot",
        requestId: "request-1",
        eventSequence: 20,
        seqNo: 20,
        invocationId: "invocation-current",
        modelStep: "worker.decision",
        admissionOutcome: "accepted",
        contextWindowTokens: 1_000,
        estimatedInputTokens: 100,
        usedContextPercent: 10,
      });
      const started = {
        type: "event",
        name: "context.compaction.started",
        requestId: "request-1",
        eventSequence: 11,
        seqNo: 21,
        beforeUsedContextPercent: 90,
      };
      controller.handle(started);
      controller.handle(terminal);
      controller.handle({ ...started, eventSequence: 19, seqNo: 22 });

      const contextWindow = state.contextWindowByRequest.get("request-1");
      expect(contextWindow?.pendingCompaction).toBeNull();
      expect(contextWindow?.lastCompactionEvent).toEqual({
        eventSequence: 12,
        seqNo: 12,
      });
      expect(
        buildConversationStatus({
          requestId: "request-1",
          streaming: true,
          contextWindow,
          events: state.events,
        })?.label,
      ).toBe("Making a decision");
      expect(state.events).toContainEqual(
        expect.objectContaining({
          eventName: "context.compaction.started",
          eventSequence: 11,
        }),
      );
    },
  );

  test.each(["completed", "failed"])(
    "clears current pending compaction on delayed %s after a newer snapshot",
    (phase) => {
      const { controller, state } = createRealtimeContextHarness();
      controller.handle({
        type: "event",
        name: "context.compaction.started",
        requestId: "request-1",
        eventSequence: 10,
        seqNo: 10,
        beforeUsedContextPercent: 90,
      });
      controller.handle({
        type: "event",
        name: "context.window.snapshot",
        requestId: "request-1",
        eventSequence: 30,
        seqNo: 30,
        invocationId: "invocation-current",
        modelStep: "worker.decision",
        admissionOutcome: "accepted",
        profileId: "new-profile",
        contextWindowTokens: 1_000,
        estimatedInputTokens: 100,
        usedContextPercent: 10,
      });
      expect(
        state.contextWindowByRequest.get("request-1")?.pendingCompaction,
      ).not.toBeNull();
      controller.handle({
        type: "event",
        name: `context.compaction.${phase}`,
        requestId: "request-1",
        eventSequence: 20,
        seqNo: 31,
        beforeUsedContextPercent: 90,
        afterUsedContextPercent: 10,
      });

      const contextWindow = state.contextWindowByRequest.get("request-1");
      expect(contextWindow?.pendingCompaction).toBeNull();
      expect(contextWindow?.lastCompactionEvent).toEqual({
        eventSequence: 20,
        seqNo: 31,
      });
      expect(
        buildConversationStatus({
          requestId: "request-1",
          streaming: true,
          contextWindow,
          events: state.events,
        })?.label,
      ).toBe("Making a decision");
    },
  );
});
