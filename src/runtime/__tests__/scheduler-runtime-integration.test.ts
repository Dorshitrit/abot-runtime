import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import {
  createSchedulerRuntimeFixture,
  createSchedulerTestGate,
  scheduledModelMessages,
  SCHEDULED_ANSWER,
  SCHEDULED_PROMPT,
} from "./support/scheduler-runtime-fixture.js";

const fixtures: Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>[] =
  [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  resetDebugLoggerConfig();
});

async function fixture(
  ...args: Parameters<typeof createSchedulerRuntimeFixture>
) {
  const created = await createSchedulerRuntimeFixture(...args);
  fixtures.push(created);
  return created;
}

describe("scheduled requests through runtime composition", () => {
  test.each(["supervisor-worker-v1", "execution-agent-v1"] as const)(
    "runs %s through canonical history, message persistence and terminal settlement",
    async (policy) => {
      const {
        application,
        scheduler,
        invoke,
        invokeRaw,
        events,
        createJob,
        waitForRun,
      } = await fixture(policy);
      const job = await createJob();
      expect(job.toolPermissionMode).toBe("full_access");
      const pending = await scheduler.runNow(job.id);
      await scheduler.tick();
      const settled = await waitForRun(pending.id);
      expect(settled.error).toBeUndefined();
      expect(settled).toMatchObject({
        status: "succeeded",
        resultText: SCHEDULED_ANSWER,
        resultMessageId: expect.any(String),
      });
      const session =
        await application.services.sessions.getSessionById("session");
      const userMessages = session!.messages.filter(
        (message) =>
          message.role === "user" && message.requestId === pending.requestId,
      );
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]).toMatchObject({
        content: SCHEDULED_PROMPT,
        source: "cron",
        schedule: { jobId: job.id, runId: pending.id, triggerType: "manual" },
      });
      const answers = session!.messages.filter(
        (message) =>
          message.role === "assistant" &&
          message.requestId === pending.requestId,
      );
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({
        id: settled.resultMessageId,
        content: SCHEDULED_ANSWER,
      });
      expect(session!.messages).toHaveLength(4);
      const decisionStep =
        policy === "execution-agent-v1"
          ? "execution.decision"
          : "supervisor.decision";
      const decisionInput = invoke.mock.calls.find(
        ([input]) => input.modelStep === decisionStep,
      )![0];
      const messages = scheduledModelMessages(decisionInput);
      expect(
        messages.filter(
          (message) =>
            message.role === "user" && message.content === SCHEDULED_PROMPT,
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(messages)).toContain(
        "Earlier preference: use brief answers.",
      );
      expect(JSON.stringify(messages)).toContain(
        "I will keep the answer brief.",
      );
      for (const [input] of invoke.mock.calls) {
        expect(input.modelPreference).toEqual({
          profileId: "scheduled-model",
          scope: "all",
        });
      }
      expect(invokeRaw).not.toHaveBeenCalled();
      expect(
        events.filter(
          (event) =>
            event.event === "schedule.triggered" ||
            event.name === "schedule.triggered" ||
            event.type === "schedule.triggered",
        ),
      ).toHaveLength(1);
      expect(events.filter((event) => event.type === "completed")).toHaveLength(
        1,
      );
    },
  );

  test.each(["cancel", "delete"] as const)(
    "%s prevents a pending scheduled request from invoking any model",
    async (action) => {
      const { application, scheduler, invoke, createJob } = await fixture();
      const job = await createJob();
      const pending = await scheduler.runNow(job.id);
      if (action === "cancel") await scheduler.cancel(job.id);
      if (action === "delete")
        await application.services.sessions.deleteSession("session");
      await scheduler.tick();
      expect(invoke).not.toHaveBeenCalled();
      if (action === "cancel")
        expect(
          (await scheduler.listRuns()).find((run) => run.id === pending.id)
            ?.status,
        ).toBe("cancelled");
      if (action === "delete") {
        expect(await scheduler.list()).toEqual([]);
        expect(await scheduler.listRuns()).toEqual([]);
        expect(
          await application.services.sessions.getSessionById("session"),
        ).toBeNull();
      }
    },
  );

  test("an active ordinary request delays scheduled execution and its settled reply joins the scheduled history", async () => {
    const entered = createSchedulerTestGate();
    const release = createSchedulerTestGate();
    let holdFirstDecision = true;
    const { scheduler, invoke, createJob, runOrdinaryRequest, waitForRun } =
      await fixture("supervisor-worker-v1", async (input) => {
        if (input.modelStep !== "supervisor.decision" || !holdFirstDecision)
          return;
        holdFirstDecision = false;
        entered.open();
        await release.waiting;
      });
    const job = await createJob();
    const ordinary = runOrdinaryRequest(
      "New information supplied just before the schedule.",
    );
    await entered.waiting;
    const pending = await scheduler.runNow(job.id);
    await scheduler.tick();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((await scheduler.listRuns())[0].status).toBe("pending");
    release.open();
    await ordinary;
    await scheduler.tick();
    expect((await waitForRun(pending.id)).status).toBe("succeeded");
    const decisions = invoke.mock.calls.filter(
      ([input]) => input.modelStep === "supervisor.decision",
    );
    expect(decisions).toHaveLength(2);
    expect(JSON.stringify(scheduledModelMessages(decisions[1][0]))).toContain(
      "New information supplied just before the schedule.",
    );
    expect(JSON.stringify(scheduledModelMessages(decisions[1][0]))).toContain(
      SCHEDULED_ANSWER,
    );
  });

  test("a scheduled model already running may finish after session deletion without restoring messages, events or Jobs", async () => {
    const entered = createSchedulerTestGate();
    const release = createSchedulerTestGate();
    const {
      application,
      scheduler,
      events,
      config,
      createJob,
      runOrdinaryRequest,
    } = await fixture("supervisor-worker-v1", async (input) => {
      if (input.modelStep !== "supervisor.response") return;
      entered.open();
      await release.waiting;
    });
    const job = await createJob();
    await scheduler.runNow(job.id);
    await scheduler.tick();
    await entered.waiting;
    await application.services.sessions.deleteSession("session");
    const deliveredBeforeDeletion = events.length;
    release.open();
    // Admission waits for the scheduled reservation to release, then rejects the
    // deleted session. This proves the complete late finalization has settled.
    await expect(runOrdinaryRequest("must not execute")).rejects.toThrow(
      "session_deleted",
    );
    await expect(
      application.services.sessions.appendMessage(
        "session",
        "assistant",
        "late write",
      ),
    ).rejects.toMatchObject({ code: "session_deleted" });
    await vi.waitFor(
      async () => {
        expect(await scheduler.list()).toEqual([]);
        expect(await scheduler.listRuns()).toEqual([]);
        expect(
          await application.services.sessions.getSessionById("session"),
        ).toBeNull();
      },
      { timeout: 5000, interval: 10 },
    );
    expect(events.slice(deliveredBeforeDeletion)).toEqual([
      expect.objectContaining({
        type: "failed",
        sessionId: "session",
        sessionDeleted: true,
      }),
    ]);
    await expect(
      readFile(join(config.paths.sessionsDir, "session.json"), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
