import { afterEach, describe, expect, test, vi } from "vitest";
import { createRuntimeScheduler } from "../adapters/scheduler-runtime.js";
import type { RuntimeRequestHandler } from "../composition.js";
import { SessionRequestAdmission } from "../request/session-admission.js";
import { resolveScheduledExecution } from "../request/scheduled-execution.js";
import {
  createSchedulerRuntimeFixture,
  createSchedulerTestGate,
  SCHEDULED_PROMPT,
} from "./support/scheduler-runtime-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createDispatchFixture(handle: RuntimeRequestHandler["handle"]) {
  const fixture = await createSchedulerRuntimeFixture();
  cleanups.push(fixture.dispose);
  await fixture.application.stop();
  const admission = new SessionRequestAdmission(() => false);
  const sessionLookup = vi.fn(
    fixture.application.services.sessions.getSessionById,
  );
  const runtime = createRuntimeScheduler({
    config: fixture.config,
    sessions: {
      ...fixture.application.services.sessions,
      getSessionById: sessionLookup,
    },
    admission,
    isDeleted: () => false,
    handle,
  });
  cleanups.push(runtime.stop);
  await runtime.start();
  const job = await runtime.scheduler.create({
    sessionId: "session",
    title: "Dispatch contract",
    prompt: SCHEDULED_PROMPT,
    modelProfileId: "scheduled-model",
    agentMode: "deep",
    timeZone: "Asia/Jerusalem",
    schedule: { kind: "timer", delayMs: 3_600_000 },
  });
  return {
    ...fixture,
    runtime,
    job,
    admission,
    sessionLookup,
    async runNow() {
      const run = await runtime.scheduler.runNow(job.id);
      await runtime.scheduler.tick();
      await vi.waitFor(
        async () => {
          const status = (await runtime.scheduler.listRuns())[0].status;
          expect(status).not.toBe("pending");
          expect(status).not.toBe("running");
        },
        { timeout: 5000, interval: 10 },
      );
      return {
        submitted: run,
        settled: (await runtime.scheduler.listRuns())[0],
      };
    },
  };
}

describe("scheduler dispatch adapter contract", () => {
  test("submits FULL, saved model and mode, exact invocation text and correlated metadata to the canonical handler", async () => {
    const handle = vi.fn<RuntimeRequestHandler["handle"]>(
      async (ws, message) => {
        await fixture.application.services.sessions.appendMessage(
          "session",
          "assistant",
          "persisted result",
          { requestId: message.requestId as string },
        );
        ws.send(
          JSON.stringify({
            type: "completed",
            requestId: message.requestId,
            output: "persisted result",
          }),
        );
      },
    );
    const fixture = await createDispatchFixture(handle);
    fixture.runtime.subscribe(() => {
      throw new Error("view_failure");
    });
    const { submitted, settled } = await fixture.runNow();
    expect(handle).toHaveBeenCalledOnce();
    expect(handle.mock.calls[0][1]).toMatchObject({
      type: "run_request",
      requestId: submitted.requestId,
      sessionId: "session",
      text: SCHEDULED_PROMPT,
      agentMode: "deep",
      modelPreference: { profileId: "scheduled-model", scope: "all" },
      toolPermissionMode: "full_access",
    });
    expect(handle.mock.calls[0][1]).not.toHaveProperty("schedule");
    expect(
      resolveScheduledExecution(handle.mock.calls[0][2]!, {
        requestId: submitted.requestId,
        sessionId: "session",
      }),
    ).toEqual({
      jobId: fixture.job.id,
      runId: submitted.id,
      title: "Dispatch contract",
      scheduledAt: submitted.scheduledAt,
      triggerType: "manual",
    });
    expect(settled).toMatchObject({
      status: "succeeded",
      resultText: "persisted result",
      resultMessageId: expect.any(String),
    });
  });

  test("does not infer success from a resolved handler without terminal evidence", async () => {
    const fixture = await createDispatchFixture(async () => undefined);
    expect((await fixture.runNow()).settled).toMatchObject({
      status: "failed",
      error: "scheduled_request_missing_terminal",
    });
  });

  test("does not infer success from a completed event when the assistant reply was not persisted", async () => {
    const fixture = await createDispatchFixture(async (ws, message) => {
      ws.send(
        JSON.stringify({
          type: "completed",
          requestId: message.requestId,
          output: "unpersisted result",
        }),
      );
    });
    const events: Record<string, unknown>[] = [];
    fixture.runtime.subscribe((event) => events.push(event));
    expect((await fixture.runNow()).settled).toMatchObject({
      status: "failed",
      error: "scheduled_result_not_persisted",
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "failed",
        error: "scheduled_result_not_persisted",
      }),
    ]);
  });

  test("withholds completed until the final assistant persistence lookup resolves", async () => {
    const entered = createSchedulerTestGate();
    const release = createSchedulerTestGate();
    const fixture = await createDispatchFixture(async (ws, message) => {
      await fixture.application.services.sessions.appendMessage(
        "session",
        "assistant",
        "saved",
        {
          requestId: message.requestId as string,
        },
      );
      fixture.sessionLookup.mockImplementationOnce(async (sessionId) => {
        entered.open();
        await release.waiting;
        return fixture.application.services.sessions.getSessionById(sessionId);
      });
      ws.send(
        JSON.stringify({
          type: "completed",
          requestId: message.requestId,
          output: "saved",
        }),
      );
    });
    cleanups.push(async () => release.open());
    const events: Record<string, unknown>[] = [];
    fixture.runtime.subscribe((event) => events.push(event));
    const running = fixture.runNow();
    await entered.waiting;
    try {
      expect(events).toEqual([]);
    } finally {
      release.open();
      await running;
    }
    expect(events).toEqual([
      expect.objectContaining({ type: "completed", output: "saved" }),
    ]);
  });

  test("a failed final persistence lookup emits failure instead of the captured completion", async () => {
    const fixture = await createDispatchFixture(async (ws, message) => {
      fixture.sessionLookup.mockRejectedValueOnce(
        new Error("session_read_failed"),
      );
      ws.send(
        JSON.stringify({
          type: "completed",
          requestId: message.requestId,
          output: "unsure",
        }),
      );
    });
    const events: Record<string, unknown>[] = [];
    fixture.runtime.subscribe((event) => events.push(event));
    expect((await fixture.runNow()).settled).toMatchObject({
      status: "failed",
      error: "session_read_failed",
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "failed", error: "session_read_failed" }),
    ]);
  });

  test.each(["failed", "completed"] as const)(
    "a handler throwing after %s emits only the authoritative failure",
    async (type) => {
      const fixture = await createDispatchFixture(async (ws, message) => {
        ws.send(
          JSON.stringify({
            type,
            requestId: message.requestId,
            output: "premature",
            error: "early_failure",
          }),
        );
        throw new Error("handler_cleanup_failed");
      });
      const events: Record<string, unknown>[] = [];
      fixture.runtime.subscribe((event) => events.push(event));
      expect((await fixture.runNow()).settled).toMatchObject({
        status: "failed",
        error: "handler_cleanup_failed",
      });
      expect(events).toEqual([
        expect.objectContaining({
          type: "failed",
          error: "handler_cleanup_failed",
        }),
      ]);
      expect(events[0]).not.toHaveProperty("output");
    },
  );

  test("explicit restart keeps admission and suppresses old-generation completion for new subscribers", async () => {
    const entered = createSchedulerTestGate();
    const release = createSchedulerTestGate();
    let first = true;
    const fixture = await createDispatchFixture(async (ws, message) => {
      if (first) {
        first = false;
        entered.open();
        await release.waiting;
      }
      await fixture.application.services.sessions.appendMessage(
        "session",
        "assistant",
        "saved",
        {
          requestId: message.requestId as string,
        },
      );
      ws.send(
        JSON.stringify({
          type: "completed",
          requestId: message.requestId,
          output: "saved",
        }),
      );
    });
    cleanups.push(async () => release.open());
    const previous = await fixture.runtime.scheduler.runNow(fixture.job.id);
    await fixture.runtime.scheduler.tick();
    await entered.waiting;
    const stopping = fixture.runtime.stop();
    const starting = fixture.runtime.start();
    const events: Record<string, unknown>[] = [];
    fixture.runtime.subscribe((event) => events.push(event));
    await Promise.all([stopping, starting]);
    expect((await fixture.runtime.scheduler.listRuns())[0]).toMatchObject({
      id: previous.id,
      status: "interrupted",
    });
    const next = await fixture.runtime.scheduler.runNow(fixture.job.id);
    await fixture.runtime.scheduler.tick();
    expect(
      (await fixture.runtime.scheduler.listRuns()).find(
        (run) => run.id === next.id,
      )?.status,
    ).toBe("pending");
    release.open();
    await fixture.admission.whenIdle();
    expect(events).toEqual([]);
    await fixture.runtime.scheduler.tick();
    await vi.waitFor(async () => {
      expect(
        (await fixture.runtime.scheduler.listRuns()).find(
          (run) => run.id === next.id,
        )?.status,
      ).toBe("succeeded");
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "completed", requestId: next.requestId }),
    ]);
    expect(
      (await fixture.runtime.scheduler.listRuns()).find(
        (run) => run.id === previous.id,
      )?.status,
    ).toBe("interrupted");
  });

  test("ignores unrelated request completion and preserves the correlated failure", async () => {
    const fixture = await createDispatchFixture(async (ws, message) => {
      ws.send(
        JSON.stringify({
          type: "completed",
          requestId: "other-request",
          output: "unrelated",
        }),
      );
      ws.send(
        JSON.stringify({
          type: "failed",
          requestId: message.requestId,
          error: "model_failed",
        }),
      );
    });
    expect((await fixture.runNow()).settled).toMatchObject({
      status: "failed",
      error: "model_failed",
    });
  });

  test("a subscriber restarting the scheduler cannot leak its current terminal into new subscriptions", async () => {
    const fixture = await createDispatchFixture(async (ws, message) => {
      await fixture.application.services.sessions.appendMessage(
        "session",
        "assistant",
        "saved",
        {
          requestId: message.requestId as string,
        },
      );
      ws.send(
        JSON.stringify({
          type: "completed",
          requestId: message.requestId,
          output: "saved",
        }),
      );
    });
    const nextEvents: Record<string, unknown>[] = [];
    let restarted: Promise<void> | undefined;
    fixture.runtime.subscribe(() => {
      const stopped = fixture.runtime.stop();
      const started = fixture.runtime.start();
      restarted = Promise.all([stopped, started]).then(() => undefined);
      fixture.runtime.subscribe((event) => nextEvents.push(event));
    });
    await fixture.runNow();
    await restarted;
    expect(nextEvents).toEqual([]);
  });

  test("fails before dispatch when the saved model disappears instead of falling back", async () => {
    const handle = vi.fn<RuntimeRequestHandler["handle"]>();
    const fixture = await createDispatchFixture(handle);
    delete fixture.config.models!.profiles!["scheduled-model"];
    expect((await fixture.runNow()).settled).toMatchObject({
      status: "failed",
      error: "scheduled_model_unavailable",
    });
    expect(handle).not.toHaveBeenCalled();
  });
});
