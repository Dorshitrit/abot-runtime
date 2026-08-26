import { describe, expect, test, vi } from "vitest";

import type { SessionRecord } from "../../sessions/types.js";
import type { EventSink, SessionStore } from "../ports.js";
import { finalizeRequest } from "../lifecycle/request-finalizer.js";
import { RequestLifecycle } from "../orchestration/lifecycle/request-lifecycle.js";

describe("runtime request finalization", () => {
  test("persists the terminal observation with the final assistant message", async () => {
    const appendContextEntry = vi.fn<
      NonNullable<SessionStore["appendContextEntry"]>
    >(() => new Promise<SessionRecord>(() => undefined));
    const appendMessage = vi.fn<SessionStore["appendMessage"]>(async () => {
      return {} as SessionRecord;
    });
    const sessionStore = { appendMessage, appendContextEntry };
    const finalObservation = {
      observationMeta: {
        kind: "task_result" as const,
        carryPolicy: "always" as const,
        taskResultRole: "authoritative_project_handoff" as const,
      },
      observationContent: JSON.stringify({
        type: "development_handoff",
        status: "degraded",
      }),
    };
    const lifecycle = new RequestLifecycle({
      requestId: "request-atomic-finalization",
      requestTimeoutMs: 0,
      inactivityTimeoutMs: 0,
    });
    const events = createEventSink();

    try {
      await expect(
        finalizeRequest({
          rawOutput: "The runtime stopped safely.",
          events,
          lifecycle,
          sessionStore,
          sessionId: "session-atomic-finalization",
          requestId: "request-atomic-finalization",
          agentMode: "reasoning",
          finalObservation,
        }),
      ).resolves.toEqual({
        status: "completed",
        output: "The runtime stopped safely.",
      });
    } finally {
      lifecycle.dispose();
    }

    expect(appendContextEntry).not.toHaveBeenCalled();
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(
      "session-atomic-finalization",
      "assistant",
      "The runtime stopped safely.",
      expect.objectContaining({
        grounding: "conversation",
        observationMeta: finalObservation.observationMeta,
        observationContent: finalObservation.observationContent,
      }),
    );
    expect(events.runtimeState).toHaveBeenCalledExactlyOnceWith({
      stage: "finalization",
    });
    expect(events.event).toHaveBeenCalledExactlyOnceWith("thinking.completed");
  });

  test("preserves exact terminal bytes while omission keeps legacy normalization", async () => {
    const exactAppendMessage = vi.fn<SessionStore["appendMessage"]>(
      async () => ({}) as SessionRecord,
    );
    const exactEvents = createEventSink();
    const exactLifecycle = new RequestLifecycle({
      requestId: "request-exact-finalization",
      requestTimeoutMs: 0,
      inactivityTimeoutMs: 0,
    });
    const exactOutput = "  Exact response.\n\t";
    try {
      await expect(
        finalizeRequest({
          rawOutput: exactOutput,
          outputTextMode: "exact",
          events: exactEvents,
          lifecycle: exactLifecycle,
          sessionStore: { appendMessage: exactAppendMessage },
          sessionId: "session-exact-finalization",
          requestId: "request-exact-finalization",
          agentMode: "reasoning",
        }),
      ).resolves.toEqual({ status: "completed", output: exactOutput });
    } finally {
      exactLifecycle.dispose();
    }
    expect(exactAppendMessage).toHaveBeenCalledWith(
      "session-exact-finalization",
      "assistant",
      exactOutput,
      expect.any(Object),
    );
    expect(exactEvents.completed).toHaveBeenCalledExactlyOnceWith(exactOutput);

    const normalizedAppendMessage = vi.fn<SessionStore["appendMessage"]>(
      async () => ({}) as SessionRecord,
    );
    const normalizedEvents = createEventSink();
    const normalizedLifecycle = new RequestLifecycle({
      requestId: "request-normalized-finalization",
      requestTimeoutMs: 0,
      inactivityTimeoutMs: 0,
    });
    try {
      await expect(
        finalizeRequest({
          rawOutput: "  Normalized response.\n\t",
          events: normalizedEvents,
          lifecycle: normalizedLifecycle,
          sessionStore: { appendMessage: normalizedAppendMessage },
          sessionId: "session-normalized-finalization",
          requestId: "request-normalized-finalization",
          agentMode: "reasoning",
        }),
      ).resolves.toEqual({
        status: "completed",
        output: "Normalized response.",
      });
    } finally {
      normalizedLifecycle.dispose();
    }
    expect(normalizedAppendMessage).toHaveBeenCalledWith(
      "session-normalized-finalization",
      "assistant",
      "Normalized response.",
      expect.any(Object),
    );
  });

  test("rejects whitespace-only output even in exact mode", async () => {
    const appendMessage = vi.fn<SessionStore["appendMessage"]>(
      async () => ({}) as SessionRecord,
    );
    const events = createEventSink();
    const lifecycle = new RequestLifecycle({
      requestId: "request-blank-exact-finalization",
      requestTimeoutMs: 0,
      inactivityTimeoutMs: 0,
    });
    try {
      await expect(
        finalizeRequest({
          rawOutput: " \n\t ",
          outputTextMode: "exact",
          events,
          lifecycle,
          sessionStore: { appendMessage },
          sessionId: "session-blank-exact-finalization",
          requestId: "request-blank-exact-finalization",
          agentMode: "reasoning",
        }),
      ).resolves.toEqual({ status: "failed" });
    } finally {
      lifecycle.dispose();
    }
    expect(appendMessage).not.toHaveBeenCalled();
    expect(events.failed).toHaveBeenCalledExactlyOnceWith(
      "invalid_final_output",
      expect.objectContaining({ reason: "empty_final_output" }),
    );
  });
});

function createEventSink(): EventSink {
  return {
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
}
