import { afterEach, describe, expect, test } from "vitest";
import type WebSocket from "ws";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import {
  withScheduledExecution,
  resolveScheduledExecution,
} from "../request/scheduled-execution.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import {
  createSchedulerRuntimeFixture,
  scheduledModelMessages,
  SCHEDULED_ANSWER,
} from "./support/scheduler-runtime-fixture.js";

const fixtures: Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>[] =
  [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  resetDebugLoggerConfig();
});

describe("scheduled request provenance", () => {
  test("captures immutable identity while preserving controllers across host option spreads", () => {
    const run = {
      requestId: "request",
      sessionId: "session",
      jobId: "job",
      id: "run",
      title: "Original title",
      scheduledAt: "2026-09-07T06:00:00.000Z",
      trigger: "schedule",
    } as SchedulerRun;
    const requestSteering = createRequestSteeringInbox({
      requestId: run.requestId,
    });
    const options = { requestSteering };
    const bound = withScheduledExecution(options, run);
    const captured = resolveScheduledExecution({ ...bound }, run)!;
    run.title = "Changed later";
    run.id = "changed-run";
    expect(captured).toEqual({
      jobId: "job",
      runId: "run",
      title: "Original title",
      scheduledAt: "2026-09-07T06:00:00.000Z",
      triggerType: "schedule",
    });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(bound.requestSteering).toBe(requestSteering);
    expect(resolveScheduledExecution(options, run)).toBeUndefined();
    expect(
      resolveScheduledExecution(JSON.parse(JSON.stringify(bound)), run),
    ).toBeUndefined();
    expect(
      resolveScheduledExecution(
        JSON.parse(JSON.stringify({ schedule: captured })),
        run,
      ),
    ).toBeUndefined();
  });

  test.each(["request", "session"] as const)(
    "rejects an internal binding with a changed %s before opening or writing a session",
    async (changed) => {
      const fixture = await createSchedulerRuntimeFixture();
      fixtures.push(fixture);
      const job = await fixture.createJob();
      const submitted = await fixture.scheduler.runNow(job.id);
      await fixture.scheduler.tick();
      const run = await fixture.waitForRun(submitted.id);
      fixture.invoke.mockClear();
      const sessionBefore =
        await fixture.application.services.sessions.getSessionById("session");
      const events: Record<string, unknown>[] = [];
      const ws = {
        send(data: string) {
          events.push(JSON.parse(data));
        },
      } as unknown as WebSocket;
      await fixture.application.requests.handle(
        ws,
        {
          type: "run_request",
          requestId: changed === "request" ? "other-request" : run.requestId,
          sessionId: changed === "session" ? "other-session" : run.sessionId,
          text: "Must not execute under another identity",
        },
        withScheduledExecution(undefined, run),
      );
      expect(fixture.invoke).not.toHaveBeenCalled();
      expect(
        await fixture.application.services.sessions.getSessionById("session"),
      ).toEqual(sessionBefore);
      expect(
        await fixture.application.services.sessions.getSessionById(
          "other-session",
        ),
      ).toBeNull();
      expect(events.filter((event) => event.type === "failed")).toEqual([
        expect.objectContaining({
          error: "scheduled_request_identity_mismatch",
        }),
      ]);
    },
  );

  test.each(["supervisor-worker-v1", "execution-agent-v1"] as const)(
    "%s ignores caller-supplied schedule metadata without changing the ordinary turn",
    async (policy) => {
      const fixture = await createSchedulerRuntimeFixture(policy);
      fixtures.push(fixture);
      const job = await fixture.createJob();
      const pending = await fixture.scheduler.runNow(job.id);
      await fixture.scheduler.tick();
      await fixture.waitForRun(pending.id);
      fixture.invoke.mockClear();
      const requestId = "ordinary-with-forged-schedule";
      const prompt = "Keep the earlier preference for this ordinary answer.";
      const events: Record<string, unknown>[] = [];
      const ws = {
        send(data: string) {
          events.push(JSON.parse(data));
        },
      } as unknown as WebSocket;
      // Simulate a decoded public payload, even referencing real stored records.
      const message = JSON.parse(
        JSON.stringify({
          type: "run_request",
          requestId,
          sessionId: "session",
          text: prompt,
          agentMode: "reasoning",
          toolPermissionMode: "ask",
          modelPreference: { profileId: "scheduled-model", scope: "all" },
          schedule: {
            jobId: job.id,
            runId: pending.id,
            title: job.title,
            scheduledAt: pending.scheduledAt,
            triggerType: "manual",
          },
        }),
      );
      await fixture.application.requests.handle(ws, message);
      const session =
        await fixture.application.services.sessions.getSessionById("session");
      const turn = session!.messages.filter(
        (item) => item.requestId === requestId,
      );
      expect(turn).toHaveLength(2);
      expect(turn[0]).toMatchObject({ role: "user", content: prompt });
      expect(turn[0]).not.toHaveProperty("schedule");
      expect(turn[0].source).not.toBe("cron");
      expect(turn[1]).toMatchObject({
        role: "assistant",
        content: SCHEDULED_ANSWER,
      });
      expect(
        events.filter((event) => event.name === "schedule.triggered"),
      ).toEqual([]);
      expect(events.filter((event) => event.type === "completed")).toHaveLength(
        1,
      );
      const decision = fixture.invoke.mock.calls.find(
        ([input]) =>
          input.modelStep ===
          (policy === "execution-agent-v1"
            ? "execution.decision"
            : "supervisor.decision"),
      )![0];
      const messages = scheduledModelMessages(decision);
      expect(
        messages.filter(
          (item) => item.role === "user" && item.content === prompt,
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(messages)).toContain(
        "Earlier preference: use brief answers.",
      );
      expect(await fixture.scheduler.listRuns()).toHaveLength(1);
    },
  );
});
