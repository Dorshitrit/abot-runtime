import { afterEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { RequestToolResources } from "../capabilities/request-tool-resources.js";
import { createRequestCancellationError } from "../request/cancellation.js";
import {
  createSchedulerRuntimeFixture,
  createSchedulerTestGate,
} from "./support/scheduler-runtime-fixture.js";

afterEach(() => vi.restoreAllMocks());

test.each(["supervisor-worker-v1", "execution-agent-v1"] as const)(
  "%s rejects overlapping history/model work while allowing other sessions",
  async (policy) => {
    const entered = createSchedulerTestGate();
    const execution = createSchedulerTestGate();
    let firstModel = true;
    const f = await createSchedulerRuntimeFixture(policy, async () => {
      if (!firstModel) return;
      firstModel = false;
      entered.open();
      await execution.waiting;
    });
    const first = f.runOrdinaryRequest("First request", "first");
    try {
      await entered.waiting;
      const before = await f.application.services.sessions.getSessionById("session");
      const modelCalls = f.invoke.mock.calls.length;
      await expect(f.runOrdinaryRequest("Duplicate follow-up", "second"))
        .rejects.toThrow("session_busy");
      expect(f.invoke).toHaveBeenCalledTimes(modelCalls);
      expect(f.invokeRaw).not.toHaveBeenCalled();
      expect(await f.application.services.sessions.getSessionById("session"))
        .toEqual(before);
      expect(await f.application.services.sessions.getRequestReplayById("second", 0))
        .toBeNull();
      await f.application.services.sessions.getOrCreateSession("other");
      await f.application.services.sessions.updateSessionTitle("other", "Other conversation");
      await f.application.requests.handle({ send() {} } as unknown as WebSocket, {
        type: "run_request", requestId: "other-request", sessionId: "other",
        text: "A separate session", agentMode: "reasoning",
        modelPreference: { profileId: "scheduled-model", scope: "all" },
      });
      expect((await f.application.services.sessions.getRequestReplayById("other-request", 0))
        ?.finalState?.status).toBe("completed");
      execution.open();
      await first;
      await f.runOrdinaryRequest("After completion", "next");
      expect((await f.application.services.sessions.getRequestReplayById("next", 0))
        ?.finalState?.status).toBe("completed");
    } finally {
      execution.open();
      await first;
      await f.dispose();
    }
  },
);

test("cancellation retains the claim until tool-resource cleanup settles", async () => {
  const entered = createSchedulerTestGate();
  const cleaning = createSchedulerTestGate();
  const cleanup = createSchedulerTestGate();
  let firstModel = true;
  const f = await createSchedulerRuntimeFixture("execution-agent-v1", async (input) => {
    if (!firstModel) return;
    firstModel = false;
    entered.open();
    await new Promise<void>((_resolve, reject) => {
      input.abortSignal.addEventListener("abort", () => reject(input.abortSignal.reason), { once: true });
    });
  });
  const originalDispose = RequestToolResources.prototype.dispose;
  let firstDispose = true;
  vi.spyOn(RequestToolResources.prototype, "dispose").mockImplementation(function (this: RequestToolResources) {
    if (firstDispose) {
      firstDispose = false;
      this.onRequestDispose(async () => { cleaning.open(); await cleanup.waiting; });
    }
    return originalDispose.call(this);
  });
  const abort = new AbortController();
  const first = f.application.requests.handle({ send() {} } as unknown as WebSocket, {
    type: "run_request", requestId: "cancelled", sessionId: "session", text: "Stop this request",
    agentMode: "reasoning", modelPreference: { profileId: "scheduled-model", scope: "all" },
  }, { abortSignal: abort.signal });
  try {
    await entered.waiting;
    abort.abort(createRequestCancellationError());
    await cleaning.waiting;
    await expect(f.runOrdinaryRequest("Too early", "competing"))
      .rejects.toThrow("session_busy");
    expect(await f.application.services.sessions.getRequestReplayById("competing", 0))
      .toBeNull();
    cleanup.open();
    await first;
    expect((await f.application.services.sessions.getRequestReplayById("cancelled", 0))
      ?.finalState).toMatchObject({ status: "failed", error: "request_cancelled" });
    await f.runOrdinaryRequest("After cancellation", "after-cancel");
    expect((await f.application.services.sessions.getRequestReplayById("after-cancel", 0))
      ?.finalState?.status).toBe("completed");
  } finally {
    abort.abort(createRequestCancellationError());
    cleanup.open();
    await first;
    await f.dispose();
  }
});
