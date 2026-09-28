import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createRuntimeEventBus } from "../events/runtime-emitter.js";
import { finalizeRequest } from "../lifecycle/request-finalizer.js";
import { LocalRequestControls } from "../local-host/app-request-control.js";
import { RequestLifecycle } from "../orchestration/lifecycle/request-lifecycle.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { SchedulerRun } from "../scheduler/contracts.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function completionGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test.each(["ordinary", "scheduled"] as const)(
  "%s completion closes Stop before persistence and until owner cleanup",
  async (origin) => {
    const controls = new LocalRequestControls(() => {});
    const options =
      origin === "ordinary"
        ? controls.ordinary(
            "request",
            {
              id: "peer",
              callClient: async () => null,
              onClose: () => () => {},
            },
            {},
            "session",
          )
        : controls.scheduled({
            requestId: "request",
            sessionId: "session",
          } as SchedulerRun);
    const lifecycle = new RequestLifecycle({
      requestId: "request",
      abortSignal: options.abortSignal,
    });
    const store = createInMemorySessionStore();
    await store.getOrCreateSession("session");
    const events: Record<string, unknown>[] = [];
    const sink = createRuntimeEventBus({
      requestId: "request",
      ws: {
        send: (data: string) => events.push(JSON.parse(data)),
      } as unknown as WebSocket,
    });
    const persistenceStarted = completionGate();
    const finishPersistence = completionGate();
    const result = finalizeRequest({
      rawOutput: "Finished",
      lifecycle,
      events: sink,
      claimFinalization: options.claimFinalization,
      sessionStore: {
        appendMessage: async (...args) => {
          persistenceStarted.release();
          await finishPersistence.promise;
          return store.appendMessage(...args);
        },
      },
      sessionId: "session",
      requestId: "request",
      agentMode: "reasoning",
    });
    try {
      await persistenceStarted.promise;
      expect(controls.cancel("request", "session")).toEqual({
        accepted: false,
        reason: "request_not_active",
      });
      expect(options.abortSignal?.aborted).toBe(false);
      finishPersistence.release();
      await result;
      expect(controls.cancel("request", "session").accepted).toBe(false);
      expect(events.filter((event) => event.type === "completed")).toHaveLength(
        1,
      );
      expect((await store.getSessionById("session"))?.messages).toHaveLength(1);
    } finally {
      finishPersistence.release();
      await result;
      lifecycle.dispose();
      controls.stop();
    }
  },
);

test("a Stop accepted before the terminal claim prevents final-response persistence", async () => {
  const controls = new LocalRequestControls(() => {});
  const options = controls.ordinary(
    "request",
    { id: "peer", callClient: async () => null, onClose: () => () => {} },
    {},
    "session",
  );
  const lifecycle = new RequestLifecycle({
    requestId: "request",
    abortSignal: options.abortSignal,
  });
  const appendMessage = vi.fn();
  const send = vi.fn();
  const sink = createRuntimeEventBus({
    requestId: "request",
    ws: { send } as unknown as WebSocket,
  });
  expect(controls.cancel("request", "session")).toEqual({ accepted: true });
  controls.stop();
  try {
    await expect(
      finalizeRequest({
        rawOutput: "Too late",
        lifecycle,
        events: sink,
        sessionStore: { appendMessage },
        claimFinalization: options.claimFinalization,
        sessionId: "session",
        requestId: "request",
        agentMode: "reasoning",
      }),
    ).rejects.toThrow("request_cancelled");
    expect(appendMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  } finally {
    lifecycle.dispose();
    controls.stop();
  }
});
