import { describe, expect, test, vi } from "vitest";
import { normalizeRealtimeMessage } from "../../web-ui/app/controllers/realtime-event-controller.js";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import type { ContextWindowState } from "../../web-ui/app/lib/context-window-state.js";
import {
  contextSnapshotEvent,
  compactionEvent,
  createScopedContextHarness,
} from "./support/context-evidence-fixture.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

function lifecycle(
  generation = "generation-1",
  status = "streaming",
  revision = 1,
) {
  return {
    schemaVersion: 1,
    requestId: "request-1",
    generation,
    status,
    revision,
  };
}
function payload(events: Record<string, unknown>[], status = "completed") {
  return {
    messages: [
      {
        id: "assistant-1",
        requestId: "request-1",
        role: "assistant",
        text: "answer",
      },
    ],
    requests: [
      {
        requestId: "request-1",
        status,
        lifecycle: lifecycle("generation-1", status),
        events,
      },
    ],
  };
}
function context(state: {
  contextWindowByRequest: Map<string, Record<string, unknown>>;
}) {
  return state.contextWindowByRequest.get("request-1") as
    | ContextWindowState
    | undefined;
}

describe("context scope and replay acceptance", () => {
  test.each([
    { requestId: "foreign" },
    { requestId: "" },
    { sessionId: "foreign" },
    { environment: "foreign" },
    { generation: "old" },
    { generation: undefined },
  ])(
    "B7 foreign or unbound evidence cannot change the current metric: %j",
    (extra) => {
      const h = createScopedContextHarness();
      h.send(contextSnapshotEvent());
      const previous = h.current();
      h.send(
        contextSnapshotEvent({
          eventSequence: 100,
          measuredInputTokens: 1,
          ...extra,
        }),
      );
      expect(h.current()).toBe(previous);
    },
  );

  test("B8 repeated normalization preserves clock provenance instead of comparing synthesized seqNo", () => {
    const h = createScopedContextHarness();
    const first = normalizeRealtimeMessage(
      normalizeRealtimeMessage(contextSnapshotEvent()),
    );
    h.send(first);
    h.send(
      contextSnapshotEvent({
        eventSequence: undefined,
        seqNo: 100,
        measuredInputTokens: 1,
      }),
    );
    expect(h.current()?.snapshot?.inputTokens).toBe(21292);
    h.send(
      contextSnapshotEvent({
        eventSequence: 9,
        seqNo: 101,
        measuredInputTokens: 2,
      }),
    );
    h.send(
      contextSnapshotEvent({
        eventSequence: 10,
        seqNo: 102,
        measuredInputTokens: 3,
      }),
    );
    h.send(
      contextSnapshotEvent({
        eventSequence: undefined,
        measuredInputTokens: 4,
      }),
    );
    expect(h.current()?.snapshot?.inputTokens).toBe(21292);
    h.send(
      contextSnapshotEvent({ eventSequence: 11, measuredInputTokens: 100 }),
    );
    expect(h.current()?.snapshot?.inputTokens).toBe(100);
  });

  test("B8 real session replay cannot replace original sequence with unrelated transport numbering", async () => {
    const events = [
      contextSnapshotEvent(),
      contextSnapshotEvent({
        eventSequence: undefined,
        seqNo: 100,
        measuredInputTokens: 1,
      }),
    ];
    const h = createPlanLifecycleHarness(payload(events));
    await h.conversationSession.openSession("session-1");
    expect(context(h.state)?.snapshot?.inputTokens).toBe(21292);
  });

  test("B9 canonical replay and reversed live delivery converge on metric, usage and conflicted outcome", async () => {
    const events = [
      compactionEvent("started", 5),
      contextSnapshotEvent(),
      {
        type: "event",
        name: "context.window.provider_usage",
        requestId: "request-1",
        invocationId: "invocation-1",
        eventSequence: 11,
        inputTokens: 21292,
      },
      compactionEvent("completed", 12),
      compactionEvent("failed", 13),
    ];
    const live = createScopedContextHarness();
    for (const event of [...events].reverse()) live.send(event);
    const replay = createPlanLifecycleHarness(payload(events));
    await replay.conversationSession.openSession("session-1");
    for (const event of events)
      replay.realtime.handle({
        ...event,
        sessionId: "session-1",
        generation: "generation-1",
      });
    const projected = (value: ContextWindowState | undefined) => ({
      tokens: value?.snapshot?.inputTokens,
      ratio: value?.snapshot?.usedContextPercent,
      usage: value?.providerUsage?.inputTokens,
      status: value?.cycles.get("outer-1")?.status,
      arrow: value?.lastCompaction,
      pending: value?.pendingCompaction,
    });
    expect(projected(context(replay.state))).toEqual(projected(live.current()));
    expect(projected(live.current())).toMatchObject({
      tokens: 21292,
      ratio: 66.5,
      usage: 21292,
      status: "conflicted",
      arrow: null,
      pending: null,
    });
  });

  test("B9 restored canonical terminal without a clock preserves explicit completed history", async () => {
    const events = [
      compactionEvent("started", 5),
      contextSnapshotEvent(),
      compactionEvent("completed", 12),
    ];
    const h = createPlanLifecycleHarness(payload(events));
    await h.conversationSession.openSession("session-1");
    expect(context(h.state)?.cycles.get("outer-1")?.status).toBe("completed");
    expect(context(h.state)?.lastCompaction).toMatchObject({
      invocationId: "outer-1",
      beforePercent: 88.3,
      afterPercent: 37.7,
    });
    expect(context(h.state)?.pendingCompaction).toBeNull();
  });

  test("B10 accepted generation replacement clears old metrics and cycles; ASK activation cannot pair IDs", () => {
    const h = createScopedContextHarness();
    h.send(contextSnapshotEvent());
    h.send(
      compactionEvent("started", 11, "activation-one", { activationId: "one" }),
    );
    h.send(
      compactionEvent("completed", 12, "activation-two", {
        activationId: "two",
      }),
    );
    expect(h.current()?.pendingCompaction?.invocationId).toBe("activation-one");
    h.send({
      type: "event",
      name: "request.lifecycle.changed",
      requestId: "request-1",
      generation: "generation-2",
      lifecycle: lifecycle("generation-2"),
      eventSequence: 1,
    });
    expect(h.current()).toBeUndefined();
    h.send(
      contextSnapshotEvent({
        generation: "generation-2",
        eventSequence: 2,
        measuredInputTokens: 100,
      }),
    );
    const current = h.current();
    h.send(
      contextSnapshotEvent({ eventSequence: 100, measuredInputTokens: 99 }),
    );
    expect(h.current()).toBe(current);
    expect(h.current()?.cycles.size).toBe(0);
  });

  test.each(["navigation", "generation", "environment"])(
    "B10 drops async replay after %s changes",
    async (change) => {
      let environmentId = "dev";
      const h = createPlanLifecycleHarness(
        payload([], "streaming"),
        [],
        () => environmentId,
      );
      let resolve!: (events: unknown[]) => void;
      h.client.fetchRequestEvents.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const opening = h.conversationSession.openSession("session-1");
      await vi.waitFor(() =>
        expect(h.client.fetchRequestEvents).toHaveBeenCalled(),
      );
      if (change === "navigation")
        h.conversationSession.clearCurrentSessionView();
      if (change === "environment") environmentId = "other";
      if (change === "generation")
        h.realtime.handle({
          type: "event",
          name: "request.lifecycle.changed",
          requestId: "request-1",
          sessionId: "session-1",
          lifecycle: lifecycle("generation-2"),
          generation: "generation-2",
        });
      resolve([contextSnapshotEvent()]);
      await opening;
      expect(context(h.state)).toBeUndefined();
    },
  );

  test("B12 legacy replay binds missing generation only to its trusted enclosing request", async () => {
    const h = createPlanLifecycleHarness(
      payload([
        contextSnapshotEvent({
          measuredInputTokens: undefined,
          estimatedInputTokens: 3200,
        }),
        compactionEvent("started", 11, ""),
        compactionEvent("completed", 12, ""),
        contextSnapshotEvent({
          eventSequence: 13,
          generation: "foreign",
          measuredInputTokens: 1,
        }),
      ]),
    );
    await h.conversationSession.openSession("session-1");
    expect(context(h.state)?.snapshot).toMatchObject({
      generation: "generation-1",
      inputTokens: 3200,
      measurementKind: "estimated",
    });
    expect(context(h.state)?.cycles.size).toBe(0);
    h.realtime.handle(
      contextSnapshotEvent({ eventSequence: 14, measuredInputTokens: 2 }),
    );
    expect(context(h.state)?.snapshot?.inputTokens).toBe(3200);
  });

  test("B12 unsequenced legacy replay follows trusted input order without creating a modern cycle", async () => {
    const events = [
      contextSnapshotEvent({
        eventSequence: undefined,
        measuredInputTokens: undefined,
        estimatedInputTokens: 100,
      }),
      contextSnapshotEvent({
        eventSequence: undefined,
        measuredInputTokens: undefined,
        estimatedInputTokens: 200,
      }),
    ];
    const legacyPayload = {
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          requestId: "request-1",
          text: "legacy",
        },
      ],
      requests: [{ requestId: "request-1", status: "completed", events }],
    };
    const h = createPlanLifecycleHarness(legacyPayload);
    await h.conversationSession.openSession("session-1");
    expect(context(h.state)?.snapshot?.inputTokens).toBe(200);
    expect(
      buildConversationActivityModel({
        requestId: "request-1",
        contextWindow: context(h.state),
      }).contextWindow?.measurementKind,
    ).toBe("estimated");
  });
});
