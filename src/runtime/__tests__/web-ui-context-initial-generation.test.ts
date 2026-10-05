import { describe, expect, test } from "vitest";
import type { ContextWindowState } from "../../web-ui/app/lib/context-window-state.js";
import {
  bindContextReplayEvents,
  captureContextReplayScope,
} from "../../web-ui/app/lib/context-window-replay.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

function event(extra: Record<string, unknown> = {}) {
  return {
    type: "event",
    name: "context.window.snapshot",
    requestId: "request-1",
    sessionId: "session-1",
    environment: "dev",
    generation: "generation-1",
    activationId: "activation-1",
    eventSequence: 10,
    seqNo: 10,
    invocationId: "invocation-1",
    modelStep: "execution.decision",
    profileId: "luna",
    measuredInputTokens: 21292,
    contextWindowTokens: 32000,
    ...extra,
  };
}
function current(h: ReturnType<typeof createPlanLifecycleHarness>) {
  return h.state.contextWindowByRequest.get("request-1") as
    | ContextWindowState
    | undefined;
}
function lifecycle(
  h: ReturnType<typeof createPlanLifecycleHarness>,
  generation: string,
  status = "streaming",
  revision = 1,
) {
  h.realtime.handle({
    type: "event",
    name: "request.lifecycle.changed",
    requestId: "request-1",
    sessionId: "session-1",
    generation,
    lifecycle: {
      schemaVersion: 1,
      requestId: "request-1",
      generation,
      status,
      revision,
    },
  });
}

describe("initial explicit context generation binding", () => {
  test("binds a fresh request from its scoped tagged event; only canonical lifecycle can replace it", () => {
    const h = createPlanLifecycleHarness();
    h.realtime.handle(event());
    expect(current(h)?.snapshot?.inputTokens).toBe(21292);
    expect(h.state.requestLifecycles?.size ?? 0).toBe(0);
    h.realtime.handle(event({ eventSequence: 11, measuredInputTokens: 16000 }));
    const accepted = current(h);
    expect(accepted?.snapshot?.inputTokens).toBe(16000);
    for (const extra of [
      { generation: undefined },
      { generation: "foreign" },
      { sessionId: "foreign" },
      { environment: "foreign" },
      { requestId: "foreign" },
    ]) {
      h.realtime.handle(
        event({ eventSequence: 12, measuredInputTokens: 1, ...extra }),
      );
      expect(current(h)).toBe(accepted);
    }
    lifecycle(h, "generation-2");
    expect(current(h)).toBeUndefined();
    h.realtime.handle(
      event({
        generation: "generation-2",
        eventSequence: 1,
        measuredInputTokens: 2000,
      }),
    );
    expect(current(h)?.snapshot?.inputTokens).toBe(2000);
    h.realtime.handle(event({ eventSequence: 99, measuredInputTokens: 1 }));
    expect(current(h)?.snapshot?.inputTokens).toBe(2000);
  });

  test.each([
    { sessionId: undefined },
    { environment: undefined },
    { eventSequence: undefined, seqNo: undefined },
    { requestId: "" },
  ])(
    "does not bind an initial live generation from an incomplete envelope: %j",
    (extra) => {
      const h = createPlanLifecycleHarness();
      h.realtime.handle(event(extra));
      expect(current(h)).toBeUndefined();
    },
  );

  test.each([
    ["", "session-1"],
    ["dev", ""],
    ["", ""],
  ])(
    "empty selected scope cannot authorize initial generation (environment=%s, session=%s)",
    (environment, sessionId) => {
      const h = createPlanLifecycleHarness({}, [], () => environment);
      h.state.currentSessionId = sessionId;
      h.realtime.handle(event({ environment, sessionId }));
      expect(current(h)).toBeUndefined();
    },
  );

  test("trusted replay captured before lifecycle accepts only explicitly consistent generation events", () => {
    const h = createPlanLifecycleHarness();
    const scope = captureContextReplayScope(h.state, "dev", "request-1");
    expect(scope.generation).toBe("");
    const batch = bindContextReplayEvents(
      [
        event({ environment: undefined }),
        event({
          environment: undefined,
          eventSequence: 11,
          seqNo: 11,
          measuredInputTokens: 16000,
        }),
        event({
          environment: undefined,
          eventSequence: 12,
          seqNo: 12,
          generation: undefined,
          measuredInputTokens: 1,
        }),
        event({
          environment: undefined,
          eventSequence: 13,
          seqNo: 13,
          generation: "foreign",
          measuredInputTokens: 2,
        }),
      ],
      scope,
    );
    for (const message of batch) h.realtime.handle(message);
    expect(current(h)?.snapshot).toMatchObject({
      generation: "generation-1",
      inputTokens: 16000,
    });
    lifecycle(h, "generation-2");
    for (const message of batch) h.realtime.handle(message);
    expect(current(h)).toBeUndefined();
  });

  test("trusted replay continues explicit generation after canonical lifecycle promotion within the same batch", () => {
    const h = createPlanLifecycleHarness();
    const scope = captureContextReplayScope(h.state, "dev", "request-1");
    const batch = bindContextReplayEvents(
      [
        event(),
        {
          type: "event",
          name: "request.lifecycle.changed",
          requestId: "request-1",
          sessionId: "session-1",
          generation: "generation-1",
          eventSequence: 11,
          seqNo: 11,
          lifecycle: {
            schemaVersion: 1,
            requestId: "request-1",
            generation: "generation-1",
            status: "streaming",
            revision: 2,
          },
        },
        event({ eventSequence: 12, seqNo: 12, measuredInputTokens: 16000 }),
        event({
          eventSequence: 13,
          seqNo: 13,
          generation: undefined,
          measuredInputTokens: 1,
        }),
        event({
          eventSequence: 14,
          seqNo: 14,
          generation: "foreign",
          measuredInputTokens: 2,
        }),
      ],
      scope,
    );
    for (const message of batch) h.realtime.handle(message);
    expect(h.state.requestLifecycles?.get("request-1")?.generation).toBe(
      "generation-1",
    );
    expect(current(h)?.snapshot).toMatchObject({
      inputTokens: 16000,
      generation: "generation-1",
    });
  });

  test("ASK activation changes retain generation while cycles remain invocation-bound", () => {
    const h = createPlanLifecycleHarness();
    h.realtime.handle(event());
    h.realtime.handle(
      event({
        name: "context.compaction.started",
        invocationId: "before-ask",
        eventSequence: 11,
      }),
    );
    lifecycle(h, "generation-1", "awaiting_approval", 2);
    lifecycle(h, "generation-1", "streaming", 3);
    h.realtime.handle(
      event({
        name: "context.compaction.started",
        invocationId: "after-ask",
        activationId: "activation-2",
        eventSequence: 12,
      }),
    );
    h.realtime.handle(
      event({
        name: "context.compaction.completed",
        invocationId: "before-ask",
        eventSequence: 13,
        beforeInputTokens: 24000,
        afterInputTokens: 8000,
      }),
    );
    expect(current(h)?.pendingCompaction?.invocationId).toBe("after-ask");
    expect(current(h)?.generation).toBe("generation-1");
    expect(current(h)?.cycles.size).toBe(2);
  });
});
