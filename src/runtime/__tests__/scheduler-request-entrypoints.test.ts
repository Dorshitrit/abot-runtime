import { afterEach, describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import type { AgentBridgeOptions } from "../../bridge/start-agent-bridge.js";
import {
  createRuntimeRequestHandler,
  type RuntimeApplication,
  type RuntimeRequestHandler,
} from "../composition.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import {
  createSchedulerRuntimeFixture,
  createSchedulerTestGate,
} from "./support/scheduler-runtime-fixture.js";

const bridge = vi.hoisted(() => ({
  start: vi.fn((_options: AgentBridgeOptions) => ({
    stop: vi.fn(async () => undefined),
    getStatus: vi.fn(),
  })),
}));
vi.mock("../../bridge/start-agent-bridge.js", () => ({
  startAgentBridge: bridge.start,
}));

const fixtures: Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>[] =
  [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  bridge.start.mockClear();
  resetDebugLoggerConfig();
});

function entrypoint(
  application: RuntimeApplication,
  kind: "public_factory" | "host_override",
): RuntimeRequestHandler {
  if (kind === "public_factory")
    return createRuntimeRequestHandler(application.services);
  application.host.start({
    eventSinkFactory: {
      create: (options) => application.services.events.create(options),
    },
  });
  const handler = bridge.start.mock.calls.at(-1)?.[0].requestHandler;
  if (!handler) throw new Error("rebound_host_request_handler_missing");
  return handler;
}

function ordinaryRequest(handler: RuntimeRequestHandler) {
  return handler.handle({ send() {} } as unknown as WebSocket, {
    type: "run_request",
    requestId: "entrypoint-ordinary",
    sessionId: "session",
    text: "Ordinary request through another public entrypoint.",
    agentMode: "reasoning",
    modelPreference: { profileId: "scheduled-model", scope: "all" },
    toolPermissionMode: "ask",
  });
}

describe.each(["public_factory", "host_override"] as const)(
  "scheduler admission through %s",
  (kind) => {
    test("does not start the scheduled model while an ordinary request is active through this entrypoint", async () => {
      const entered = createSchedulerTestGate();
      const release = createSchedulerTestGate();
      let holdFirstDecision = true;
      const fixture = await createSchedulerRuntimeFixture(
        "supervisor-worker-v1",
        async (input) => {
          if (input.modelStep !== "supervisor.decision" || !holdFirstDecision)
            return;
          holdFirstDecision = false;
          entered.open();
          await release.waiting;
        },
      );
      fixtures.push(fixture);
      const job = await fixture.createJob();
      const request = ordinaryRequest(entrypoint(fixture.application, kind));
      await entered.waiting;
      const pending = await fixture.scheduler.runNow(job.id);
      await fixture.scheduler.tick();
      try {
        expect((await fixture.scheduler.listRuns())[0].status).toBe("pending");
        expect(fixture.invoke).toHaveBeenCalledTimes(1);
      } finally {
        release.open();
        await request;
        await fixture.scheduler.tick();
        await fixture.waitForRun(pending.id);
      }
      expect((await fixture.scheduler.listRuns())[0].status).toBe("succeeded");
    });

    test("an ordinary request arriving through this entrypoint waits for a reserved scheduled run", async () => {
      const entered = createSchedulerTestGate();
      const release = createSchedulerTestGate();
      let holdScheduledDecision = true;
      const fixture = await createSchedulerRuntimeFixture(
        "supervisor-worker-v1",
        async (input) => {
          if (
            input.modelStep !== "supervisor.decision" ||
            !holdScheduledDecision
          )
            return;
          holdScheduledDecision = false;
          entered.open();
          await release.waiting;
        },
      );
      fixtures.push(fixture);
      const job = await fixture.createJob();
      const pending = await fixture.scheduler.runNow(job.id);
      await fixture.scheduler.tick();
      await entered.waiting;
      const request = ordinaryRequest(entrypoint(fixture.application, kind));
      try {
        // Let a wrongly unguarded handler finish its asynchronous session setup.
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        expect(fixture.invoke).toHaveBeenCalledTimes(1);
      } finally {
        release.open();
        await fixture.waitForRun(pending.id);
        await request;
      }
      expect(
        fixture.invoke.mock.calls.filter(
          ([input]) => input.modelStep === "supervisor.decision",
        ),
      ).toHaveLength(2);
    });
  },
);
