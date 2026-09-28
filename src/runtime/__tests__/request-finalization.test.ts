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
    const composeInvalidFinalOutput = vi.fn(async () => "Unneeded summary.");

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
          composeInvalidFinalOutput,
        }),
      ).resolves.toEqual({
        status: "completed",
        output: "The runtime stopped safely.",
      });
    } finally {
      lifecycle.dispose();
    }

    expect(appendContextEntry).not.toHaveBeenCalled();
    expect(composeInvalidFinalOutput).not.toHaveBeenCalled();
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

  test("delivers a model-authored summary for blank exact output without stale claims or memory", async () => {
    const appendMessage = vi.fn<SessionStore["appendMessage"]>(
      async () => ({}) as SessionRecord,
    );
    const events = createEventSink();
    const lifecycle = new RequestLifecycle({
      requestId: "request-blank-exact-finalization",
      requestTimeoutMs: 0,
      inactivityTimeoutMs: 0,
    });
    const authoredOutput = "  Model-authored explanation of this failure.\n\t";
    const composeInvalidFinalOutput = vi.fn(async () => authoredOutput);
    const scheduleCandidates = vi.fn();
    try {
      await expect(
        finalizeRequest({
          rawOutput: " \n\t ",
          outputTextMode: "exact",
          composeInvalidFinalOutput,
          events,
          lifecycle,
          sessionStore: { appendMessage },
          sessionId: "session-blank-exact-finalization",
          requestId: "request-blank-exact-finalization",
          agentMode: "reasoning",
          finalObservation: {
            observationMeta: { kind: "task_result", carryPolicy: "always" },
            observationContent: "Stale claimed success must not be persisted.",
          },
          memoryCandidates: [
            { content: "Stale claimed fact.", tags: ["fact"] },
          ],
          longTermMemory: {
            enabled: true,
            retrieve: vi.fn(),
            processCandidates: vi.fn(),
            scheduleCandidates,
            status: vi.fn(),
            list: vi.fn(),
            search: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
            clear: vi.fn(),
          },
        }),
      ).resolves.toEqual({ status: "completed", output: authoredOutput });
    } finally {
      lifecycle.dispose();
    }
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(composeInvalidFinalOutput).toHaveBeenCalledOnce();
    expect(appendMessage.mock.calls[0]?.[2]).toBe(authoredOutput);
    expect(appendMessage.mock.calls[0]?.[3]).not.toHaveProperty(
      "observationMeta",
    );
    expect(appendMessage.mock.calls[0]?.[3]).not.toHaveProperty(
      "observationContent",
    );
    expect(scheduleCandidates).not.toHaveBeenCalled();
    expect(events.completed).toHaveBeenCalledExactlyOnceWith(authoredOutput);
    expect(events.failed).not.toHaveBeenCalled();
  });

  test("does not recover blank output after the request is aborted", async () => {
    const events = createEventSink();
    const appendMessage = vi.fn<SessionStore["appendMessage"]>();
    const lifecycle = new RequestLifecycle({
      requestId: "blank-aborted",
      requestTimeoutMs: 0,
      inactivityTimeoutMs: 0,
    });
    const abortReason = new Error("request_aborted");
    const composeInvalidFinalOutput = vi.fn(async () => "Unneeded summary.");
    lifecycle.abortController.abort(abortReason);
    try {
      await expect(
        finalizeRequest({
          rawOutput: " ",
          composeInvalidFinalOutput,
          events,
          lifecycle,
          sessionStore: { appendMessage },
          sessionId: "session",
          requestId: "blank-aborted",
          agentMode: "reasoning",
        }),
      ).rejects.toBe(abortReason);
    } finally {
      lifecycle.dispose();
    }
    expect(appendMessage).not.toHaveBeenCalled();
    expect(composeInvalidFinalOutput).not.toHaveBeenCalled();
    expect(events.completed).not.toHaveBeenCalled();
  });

  test("does not hide persistence failure after model-authored blank-output finalization", async () => {
    const events = createEventSink();
    const persistenceFailure = new Error("session_persistence_failed");
    const appendMessage = vi.fn<SessionStore["appendMessage"]>(async () => {
      throw persistenceFailure;
    });
    const lifecycle = new RequestLifecycle({
      requestId: "blank-persistence",
      requestTimeoutMs: 0,
      inactivityTimeoutMs: 0,
    });
    try {
      await expect(
        finalizeRequest({
          rawOutput: " ",
          composeInvalidFinalOutput: async () =>
            "Model-authored failure summary.",
          events,
          lifecycle,
          sessionStore: { appendMessage },
          sessionId: "session",
          requestId: "blank-persistence",
          agentMode: "reasoning",
        }),
      ).rejects.toBe(persistenceFailure);
    } finally {
      lifecycle.dispose();
    }
    expect(events.completed).not.toHaveBeenCalled();
  });

  test("persists and completes the response after scheduling memory work", async () => {
    const order: string[] = [];
    const appendMessage = vi.fn<SessionStore["appendMessage"]>(async () => {
      order.push("response-persisted");
      return {} as SessionRecord;
    });
    const scheduleCandidates = vi.fn(() => {
      order.push("memory-scheduled");
    });
    const events = createEventSink();
    const lifecycle = new RequestLifecycle({
      requestId: "request-memory-isolation",
      requestTimeoutMs: 0,
      inactivityTimeoutMs: 0,
    });
    try {
      await expect(
        finalizeRequest({
          rawOutput: "The answer remains valid.",
          events,
          lifecycle,
          sessionStore: { appendMessage },
          sessionId: "session-memory-isolation",
          requestId: "request-memory-isolation",
          agentMode: "reasoning",
          memoryCandidates: [
            { content: "User prefers concise answers.", tags: ["preference"] },
          ],
          longTermMemory: {
            enabled: true,
            retrieve: vi.fn(),
            processCandidates: vi.fn(),
            scheduleCandidates,
            status: vi.fn(),
            list: vi.fn(),
            search: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
            clear: vi.fn(),
          },
        }),
      ).resolves.toEqual({
        status: "completed",
        output: "The answer remains valid.",
      });
    } finally {
      lifecycle.dispose();
    }

    expect(order).toEqual(["response-persisted", "memory-scheduled"]);
    expect(scheduleCandidates).toHaveBeenCalledOnce();
    expect(events.completed).toHaveBeenCalledExactlyOnceWith(
      "The answer remains valid.",
    );
    expect(events.failed).not.toHaveBeenCalled();
  });

  test("isolates a synchronous memory scheduling failure from completion", async () => {
    const events = createEventSink();
    const lifecycle = new RequestLifecycle({
      requestId: "request-memory-scheduling-failure",
      requestTimeoutMs: 0,
      inactivityTimeoutMs: 0,
    });
    try {
      await expect(
        finalizeRequest({
          rawOutput: "The answer is already complete.",
          events,
          lifecycle,
          sessionStore: {
            appendMessage: vi.fn(async () => ({}) as SessionRecord),
          },
          sessionId: "session-memory-scheduling-failure",
          requestId: "request-memory-scheduling-failure",
          agentMode: "reasoning",
          memoryCandidates: [{ content: "Durable fact.", tags: ["fact"] }],
          longTermMemory: {
            enabled: true,
            retrieve: vi.fn(),
            processCandidates: vi.fn(),
            scheduleCandidates: vi.fn(() => {
              throw new Error("queue_unavailable");
            }),
            status: vi.fn(),
            list: vi.fn(),
            search: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
            clear: vi.fn(),
          },
        }),
      ).resolves.toEqual({
        status: "completed",
        output: "The answer is already complete.",
      });
    } finally {
      lifecycle.dispose();
    }
    expect(events.completed).toHaveBeenCalledExactlyOnceWith(
      "The answer is already complete.",
    );
    expect(events.failed).not.toHaveBeenCalled();
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
