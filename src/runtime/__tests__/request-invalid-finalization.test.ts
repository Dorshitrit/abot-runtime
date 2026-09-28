import { describe, expect, test, vi } from "vitest";
import type { SessionRecord } from "../../sessions/types.js";
import type { EventSink, SessionStore } from "../ports.js";
import { finalizeRequest } from "../lifecycle/request-finalizer.js";
import { RequestLifecycle } from "../orchestration/lifecycle/request-lifecycle.js";

describe("invalid final output model-authored boundary", () => {
  test.each(["missing", "blank"] as const)(
    "rejects a %s composer result without persistence or recursive recovery",
    async (kind) => {
      const fixture = createBlankOutputFinalization();
      const composeInvalidFinalOutput = vi.fn(async () => " \n\t ");
      try {
        await expect(
          finalizeRequest({
            ...fixture.params,
            ...(kind === "blank" ? { composeInvalidFinalOutput } : {}),
          }),
        ).rejects.toThrow("invalid_final_output");
      } finally {
        fixture.params.lifecycle.dispose();
      }
      expect(composeInvalidFinalOutput).toHaveBeenCalledTimes(
        kind === "blank" ? 1 : 0,
      );
      expect(fixture.appendMessage).not.toHaveBeenCalled();
      expect(fixture.params.events.completed).not.toHaveBeenCalled();
    },
  );

  test("propagates a degraded model failure without static text or persistence", async () => {
    const fixture = createBlankOutputFinalization();
    const failure = new Error("degraded_provider_failed");
    const composeInvalidFinalOutput = vi.fn(async () => {
      throw failure;
    });
    try {
      await expect(
        finalizeRequest({ ...fixture.params, composeInvalidFinalOutput }),
      ).rejects.toBe(failure);
    } finally {
      fixture.params.lifecycle.dispose();
    }
    expect(composeInvalidFinalOutput).toHaveBeenCalledOnce();
    expect(fixture.appendMessage).not.toHaveBeenCalled();
    expect(fixture.params.events.completed).not.toHaveBeenCalled();
  });

  test("cancellation during degraded composition prevents persistence", async () => {
    const fixture = createBlankOutputFinalization();
    const abortReason = new Error("request_cancelled_during_degraded");
    const composeInvalidFinalOutput = vi.fn(async () => {
      fixture.params.lifecycle.abortController.abort(abortReason);
      return "The model produced a summary after cancellation.";
    });
    try {
      await expect(
        finalizeRequest({ ...fixture.params, composeInvalidFinalOutput }),
      ).rejects.toBe(abortReason);
    } finally {
      fixture.params.lifecycle.dispose();
    }
    expect(composeInvalidFinalOutput).toHaveBeenCalledOnce();
    expect(fixture.appendMessage).not.toHaveBeenCalled();
    expect(fixture.params.events.completed).not.toHaveBeenCalled();
  });
});

function createBlankOutputFinalization() {
  const appendMessage = vi.fn<SessionStore["appendMessage"]>(
    async () => ({}) as SessionRecord,
  );
  const events: EventSink = {
    publish: vi.fn(),
    event: vi.fn(),
    runtimeState: vi.fn(),
    token: vi.fn(),
    legacyToken: vi.fn(),
    thinkingDelta: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn(),
    drain: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  return {
    appendMessage,
    params: {
      rawOutput: " \n ",
      events,
      lifecycle: new RequestLifecycle({
        requestId: "invalid-final-output",
        requestTimeoutMs: 0,
        inactivityTimeoutMs: 0,
      }),
      sessionStore: { appendMessage },
      sessionId: "invalid-final-output-session",
      requestId: "invalid-final-output",
      agentMode: "reasoning" as const,
    },
  };
}
