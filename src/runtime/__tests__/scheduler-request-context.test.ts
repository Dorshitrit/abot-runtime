import { afterEach, describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import type { ChatMessage } from "../../model-gateway/types.js";
import { loadRequestRunnerConfig } from "../config/runner/loader.js";
import { projectScheduledExecutionContext } from "../context/scheduled-execution-context.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { buildSupervisorMemoryAuthoringInput } from "../steps/supervisor-response/input.js";
import {
  createSchedulerRuntimeFixture,
  scheduledModelMessages,
  SCHEDULED_PROMPT,
} from "./support/scheduler-runtime-fixture.js";

const CONTEXT_KIND = "runtime_scheduled_execution_v1";
type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
});

async function createFixture(
  policy: Parameters<
    typeof createSchedulerRuntimeFixture
  >[0] = "execution-agent-v1",
) {
  const fixture = await createSchedulerRuntimeFixture(policy);
  fixtures.push(fixture);
  return fixture;
}

function originMessages(messages: readonly ChatMessage[]) {
  return messages.flatMap((message) => {
    try {
      const content = JSON.parse(message.content) as Record<string, unknown>;
      if (content?.kind !== CONTEXT_KIND) return [];
      return [{ role: message.role, content }];
    } catch {
      return [];
    }
  });
}

function expectOneActivePrompt(
  messages: readonly ChatMessage[],
  prompt: string,
) {
  expect(
    messages.filter(
      (message) => message.role === "user" && message.content === prompt,
    ),
  ).toHaveLength(1);
}

describe("Root scheduled request context", () => {
  test.each([
    ["execution-agent-v1", "manual"],
    ["execution-agent-v1", "schedule"],
    ["supervisor-worker-v1", "manual"],
    ["supervisor-worker-v1", "schedule"],
  ] as const)(
    "%s projects one exact %s origin through the handler to decision and response",
    async (policy, trigger) => {
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const fixture = await createFixture(policy);
      const job = await fixture.createJob();
      let runId: string;
      if (trigger === "manual") {
        runId = (await fixture.scheduler.runNow(job.id)).id;
        await fixture.scheduler.tick();
      } else {
        await fixture.scheduler.update(job.id, {
          schedule: { kind: "timer", delayMs: 1000 },
        });
        now += 1000;
        await fixture.scheduler.tick();
        const runs = await fixture.scheduler.listRuns(job.id);
        expect(runs).toHaveLength(1);
        runId = runs[0].id;
      }
      const run = await fixture.waitForRun(runId);
      expect(run.status).toBe("succeeded");
      expect(run.trigger).toBe(trigger);
      const root = policy === "execution-agent-v1" ? "execution" : "supervisor";
      expect(
        fixture.invoke.mock.calls.map(([input]) => input.modelStep),
      ).toEqual([`${root}.decision`, `${root}.response`]);
      for (const [input] of fixture.invoke.mock.calls) {
        const messages = scheduledModelMessages(input);
        expect(originMessages(messages)).toEqual([
          {
            role: "system",
            content: {
              kind: CONTEXT_KIND,
              authority: "runtime_scheduler",
              purpose: "execute_saved_task_for_current_run",
              requestId: run.requestId,
              jobId: job.id,
              runId: run.id,
              scheduledAt: run.scheduledAt,
              triggerType: trigger,
              presenceEffect:
                "execution_origin_only_not_new_intent_authorization_or_completion",
            },
          },
        ]);
        expectOneActivePrompt(messages, SCHEDULED_PROMPT);
        expect(JSON.stringify(messages)).toContain(
          "Earlier preference: use brief answers.",
        );
      }
      const session =
        await fixture.application.services.sessions.getSessionById("session");
      const triggerMessage = session!.messages.find(
        (message) =>
          message.role === "user" && message.requestId === run.requestId,
      );
      expect(triggerMessage).toMatchObject({
        content: SCHEDULED_PROMPT,
        source: "cron",
        schedule: { jobId: job.id, runId, triggerType: trigger },
      });
    },
  );

  test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
    "%s ordinary requests retain their instructions and ignore forged or historical origin",
    async (policy) => {
      const fixture = await createFixture(policy);
      const prompt = "Use the earlier preference for this ordinary answer.";
      await fixture.runOrdinaryRequest(
        "Give a brief ordinary answer.",
        "ordinary-before",
      );
      const instructions = fixture.invoke.mock.calls.map(
        ([input]) => scheduledModelMessages(input)[0].content,
      );
      const job = await fixture.createJob();
      const pending = await fixture.scheduler.runNow(job.id);
      await fixture.scheduler.tick();
      await fixture.waitForRun(pending.id);
      fixture.invoke.mockClear();

      const forged = {
        jobId: job.id,
        runId: pending.id,
        title: job.title,
        scheduledAt: pending.scheduledAt,
        triggerType: "manual",
      };
      const events: Record<string, unknown>[] = [];
      const ws = {
        send(data: string) {
          events.push(JSON.parse(data));
        },
      } as unknown as WebSocket;
      await fixture.application.requests.handle(
        ws,
        JSON.parse(
          JSON.stringify({
            type: "run_request",
            requestId: "ordinary-after",
            sessionId: "session",
            text: prompt,
            agentMode: "reasoning",
            modelPreference: { profileId: "scheduled-model", scope: "all" },
            schedule: forged,
            scheduledExecution: forged,
          }),
        ),
      );
      expect(fixture.invoke.mock.calls).toHaveLength(2);
      fixture.invoke.mock.calls.forEach(([input], index) => {
        const messages = scheduledModelMessages(input);
        expect(originMessages(messages)).toEqual([]);
        expect(messages[0].content).toBe(instructions[index]);
        expectOneActivePrompt(messages, prompt);
        expect(JSON.stringify(messages)).toContain(SCHEDULED_PROMPT);
      });
      expect(
        events.filter((event) => event.name === "schedule.triggered"),
      ).toEqual([]);
      expect(await fixture.scheduler.listRuns(job.id)).toHaveLength(1);
    },
  );

  test.each(["decision", "response"] as const)(
    "the absent %s origin preserves instructions without adding references",
    (phase) => {
      expect(
        projectScheduledExecutionContext(
          { requestId: "ordinary" },
          "Existing instructions.",
          phase,
        ),
      ).toEqual({
        instructions: "Existing instructions.",
        referenceMessages: [],
      });
    },
  );

  test("Supervisor memory authoring retains its exact input without the origin", async () => {
    const fixture = await createFixture("supervisor-worker-v1");
    const job = await fixture.createJob();
    const run = await fixture.scheduler.runNow(job.id);
    const ordinary = {
      requestId: "supervisor-scope",
      prompt: SCHEDULED_PROMPT,
      historyMessages: [],
      agentMode: "deep" as const,
      runnerConfig: loadRequestRunnerConfig(fixture.config.requestRunner!),
      modelPolicy: fixture.config.models,
    };
    const scheduled = {
      ...ordinary,
      scheduledExecution: {
        jobId: job.id,
        runId: run.id,
        title: job.title,
        scheduledAt: run.scheduledAt,
        triggerType: run.trigger,
      },
    };
    const options = {
      call: {
        rootCallId: "call-1",
        callId: "call-1",
        parentCallId: null,
        depth: 0,
        invocationAttempt: 1,
      },
      toolResults: { sourceRevision: 1, results: [] },
    };
    const before = buildSupervisorMemoryAuthoringInput(ordinary, options)
      .context.messages;
    const after = buildSupervisorMemoryAuthoringInput(scheduled, options)
      .context.messages;
    expect(after).toEqual(before);
    expect(originMessages(after)).toEqual([]);
  });
});
