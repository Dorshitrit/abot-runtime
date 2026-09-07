import { afterEach, describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import type { AgentBridgeOptions } from "../../bridge/start-agent-bridge.js";
import {
  createDefaultRuntimeDependencies,
  createRuntimeApplication,
  createRuntimeRequestHandler,
  type RuntimeEnvironmentServices,
} from "../composition.js";
import { createDefaultRuntimeHost } from "../default-adapters.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import type { EventSinkFactory } from "../ports.js";
import {
  createSchedulerRuntimeFixture,
  createSchedulerTestGate,
} from "./support/scheduler-runtime-fixture.js";

const bridge = vi.hoisted(() => ({
  stop: vi.fn(async () => undefined),
  start: vi.fn((_options: AgentBridgeOptions) => ({
    stop: async () => bridge.stop(),
    getStatus: vi.fn(),
  })),
}));
vi.mock("../../bridge/start-agent-bridge.js", () => ({
  startAgentBridge: bridge.start,
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function stoppedFixture(
  ...args: Parameters<typeof createSchedulerRuntimeFixture>
) {
  const fixture = await createSchedulerRuntimeFixture(...args);
  cleanups.push(fixture.dispose);
  return fixture;
}

describe("compatibility host scheduler ownership", () => {
  test("lazy schedule management stays stopped until the application explicitly restarts", async () => {
    const fixture = await stoppedFixture();
    await fixture.application.stop();
    const schedules =
      fixture.application.services.tools.getImplementations().schedules;
    const context = { sharedState: { currentSessionId: "session" } };
    expect(await schedules({ action: "list" }, context)).toMatchObject({
      ok: false,
      error: "scheduler_stopped",
    });
    await fixture.application.start();
    expect(await schedules({ action: "list" }, context)).toMatchObject({
      ok: true,
    });
  });

  test("the same compatibility host can start again after its previous handle stops", async () => {
    const fixture = await stoppedFixture();
    const job = await fixture.createJob();
    await fixture.application.stop();
    const runtime = createDefaultRuntimeDependencies(fixture.config, {
      models: fixture.application.services.models,
    });
    cleanups.push(async () => runtime.stopScheduler?.());
    const first = runtime.host.start();
    cleanups.push(first.stop);
    await first.ready;
    await first.stop();
    const second = runtime.host.start();
    cleanups.push(second.stop);
    await second.ready;
    await runtime.scheduler!.runNow(job.id);
    await runtime.scheduler!.tick();
    await vi.waitFor(async () => {
      expect((await runtime.scheduler!.listRuns())[0].status).toBe("succeeded");
    });
    expect(bridge.start).toHaveBeenCalledTimes(2);
    await second.stop();
    expect(bridge.stop).toHaveBeenCalledTimes(2);
  });

  test("host start alone recovers and dispatches persisted Jobs on its clock, and stop releases ownership", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const fixture = await stoppedFixture();
    const persisted = await fixture.createJob();
    await fixture.scheduler.update(persisted.id, {
      schedule: { kind: "once", at: new Date(Date.now() + 2000).toISOString() },
    });
    await fixture.application.stop();
    const runtime = createDefaultRuntimeDependencies(fixture.config, {
      models: fixture.application.services.models,
    });
    cleanups.push(async () => runtime.stopScheduler?.());
    const handle = runtime.host.start();
    cleanups.push(handle.stop);

    await expect(runtime.scheduler!.get(persisted.id)).resolves.toMatchObject({
      id: persisted.id,
      state: "active",
    });
    await vi.advanceTimersByTimeAsync(1000);
    await runtime.scheduler!.listRuns();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => {
      expect((await runtime.scheduler!.listRuns())[0]).toMatchObject({
        jobId: persisted.id,
        status: "succeeded",
        trigger: "schedule",
      });
    });
    await handle.stop();
    await expect(runtime.scheduler!.list()).rejects.toThrow(
      "scheduler_not_started",
    );
    expect(bridge.stop).toHaveBeenCalledOnce();

    const next = createRuntimeApplication(fixture.config);
    cleanups.push(next.stop);
    await expect(next.start()).resolves.toBeUndefined();
  });

  test("session override binds scheduling, ordinary admission and deletion to the same guarded backing store", async () => {
    const entered = createSchedulerTestGate();
    const release = createSchedulerTestGate();
    let holdFirstDecision = true;
    const fixture = await stoppedFixture(
      "supervisor-worker-v1",
      async (input) => {
        if (input.modelStep !== "supervisor.decision") return;
        if (!holdFirstDecision) return;
        holdFirstDecision = false;
        entered.open();
        await release.waiting;
      },
    );
    await fixture.application.stop();
    const application = createRuntimeApplication(fixture.config, {
      models: fixture.application.services.models,
    });
    cleanups.push(application.stop);
    const custom = createInMemorySessionStore();
    await custom.appendMessage("custom-session", "user", "Custom history");
    let effective!: RuntimeEnvironmentServices;
    const host = createDefaultRuntimeHost(fixture.config, {
      services: application.services,
      requestHandlerFactory: (services) => {
        effective = services;
        return createRuntimeRequestHandler(services);
      },
    });
    const handle = host.start({ sessionStore: custom });
    cleanups.push(handle.stop);
    await effective.startScheduler!();
    const scheduler = effective.scheduler!;
    const job = await scheduler.create({
      sessionId: "custom-session",
      title: "Custom store job",
      prompt: "Use the custom conversation history.",
      modelProfileId: "scheduled-model",
      agentMode: "reasoning",
      timeZone: "Asia/Jerusalem",
      schedule: { kind: "timer", delayMs: 3_600_000 },
    });
    expect(effective.sessions).not.toBe(custom);
    expect(effective.requestAdmission).not.toBe(
      application.services.requestAdmission,
    );
    expect(effective.tools).not.toBe(application.services.tools);
    expect(bridge.start.mock.calls.at(-1)![0].sessionStore).toBe(
      effective.sessions,
    );
    const listed = await effective.tools
      .getImplementations()
      .schedules(
        { action: "list" },
        { sharedState: { currentSessionId: "custom-session" } },
      );
    expect(listed.ok).toBe(true);
    expect(JSON.parse(listed.output)).toMatchObject({ jobs: [{ id: job.id }] });

    const handler = bridge.start.mock.calls.at(-1)![0].requestHandler!;
    const ordinary = handler.handle({ send() {} } as unknown as WebSocket, {
      type: "run_request",
      requestId: "ordinary-custom",
      sessionId: "custom-session",
      text: "Ordinary custom store request",
      agentMode: "reasoning",
      modelPreference: { profileId: "scheduled-model", scope: "all" },
    });
    await entered.waiting;
    try {
      await scheduler.runNow(job.id);
      await scheduler.tick();
      expect((await scheduler.listRuns())[0].status).toBe("pending");
      expect(fixture.invoke).toHaveBeenCalledTimes(1);
      await effective.sessions.deleteSession("custom-session");
    } finally {
      release.open();
      await ordinary;
    }
    await scheduler.tick();
    expect(await custom.getSessionById("custom-session")).toBeNull();
    expect(await scheduler.list()).toEqual([]);
    expect(await scheduler.listRuns()).toEqual([]);
    await expect(
      effective.sessions.appendMessage("custom-session", "assistant", "late"),
    ).rejects.toMatchObject({ code: "session_deleted" });
  });

  test("a model adapter override also owns scheduled execution and keeps backing sessions unwrapped once", async () => {
    const fixture = await stoppedFixture();
    await fixture.application.stop();
    const staleModel = vi.fn(async () => {
      throw new Error("stale_model_called");
    });
    const application = createRuntimeApplication(fixture.config, {
      models: { invoke: staleModel, invokeRaw: staleModel },
    });
    cleanups.push(application.stop);
    let effective!: RuntimeEnvironmentServices;
    const host = createDefaultRuntimeHost(fixture.config, {
      services: application.services,
      requestHandlerFactory: (services) => {
        effective = services;
        return createRuntimeRequestHandler(services);
      },
    });
    const handle = host.start({
      modelGatewayClient: fixture.application.services.models,
    });
    cleanups.push(handle.stop);
    await handle.ready;
    const scheduler = effective.scheduler!;
    const job = await scheduler.create({
      sessionId: "session",
      title: "Rebound model",
      prompt: "Use the overridden adapter.",
      modelProfileId: "scheduled-model",
      agentMode: "reasoning",
      timeZone: "Asia/Jerusalem",
      schedule: { kind: "timer", delayMs: 3_600_000 },
    });
    await scheduler.runNow(job.id);
    await scheduler.tick();
    await vi.waitFor(async () => {
      expect((await scheduler.listRuns())[0].status).toBe("succeeded");
    });
    expect(fixture.invoke).toHaveBeenCalled();
    expect(staleModel).not.toHaveBeenCalled();
    // A nested old lifecycle facade would attempt to start the old scheduler
    // here and fail ownership, despite the replacement graph being healthy.
    await effective.sessions.deleteSession("session");
    expect(await scheduler.list()).toEqual([]);
  });

  test("an event-only override observes scheduled and ordinary execution through the effective graph", async () => {
    const fixture = await stoppedFixture();
    const application = fixture.application;
    const originalEvents = application.services.events;
    const completed: string[] = [];
    const events: EventSinkFactory = {
      create: vi.fn((options) => {
        const sink = fixture.application.services.events.create(options);
        const complete = sink.completed.bind(sink);
        sink.completed = (output) => {
          completed.push(options.requestId);
          return complete(output);
        };
        return sink;
      }),
    };
    let effective!: RuntimeEnvironmentServices;
    const host = createDefaultRuntimeHost(fixture.config, {
      services: application.services,
      requestHandlerFactory: (services) => {
        effective = services;
        return createRuntimeRequestHandler(services);
      },
    });
    const handle = host.start({ eventSinkFactory: events });
    cleanups.push(handle.stop);
    await handle.ready;
    const scheduler = effective.scheduler!;
    expect(scheduler).toBe(application.services.scheduler);
    expect(effective.sessions).toBe(application.services.sessions);
    expect(effective.requestAdmission).toBe(
      application.services.requestAdmission,
    );
    expect(effective.tools).toBe(application.services.tools);
    const job = await scheduler.create({
      sessionId: "session",
      title: "Observed scheduled run",
      prompt: "Use the effective event adapter.",
      modelProfileId: "scheduled-model",
      agentMode: "reasoning",
      timeZone: "Asia/Jerusalem",
      schedule: { kind: "timer", delayMs: 3_600_000 },
    });
    const run = await scheduler.runNow(job.id);
    await scheduler.tick();
    await vi.waitFor(async () => {
      expect((await scheduler.listRuns())[0].status).toBe("succeeded");
    });
    const handler = bridge.start.mock.calls.at(-1)![0].requestHandler!;
    await handler.handle({ send() {} } as unknown as WebSocket, {
      type: "run_request",
      requestId: "observed-ordinary",
      sessionId: "session",
      text: "Ordinary request using the effective event adapter.",
      agentMode: "reasoning",
      modelPreference: { profileId: "scheduled-model", scope: "all" },
    });
    expect(completed).toEqual([run.requestId, "observed-ordinary"]);
    expect(application.services.events).toBe(originalEvents);
    expect(effective.events).toBe(events);
    expect(bridge.start.mock.calls.at(-1)![0].eventSinkFactory).toBe(events);
    expect(fixture.events).toContainEqual(
      expect.objectContaining({ type: "completed", requestId: run.requestId }),
    );
    await effective.sessions.deleteSession("session");
    expect(await scheduler.list()).toEqual([]);
  });

  test("event rebinding preserves a running request's sink and a default host restores future scheduled events", async () => {
    const entered = createSchedulerTestGate();
    const release = createSchedulerTestGate();
    let holdFirstDecision = true;
    const fixture = await stoppedFixture(
      "supervisor-worker-v1",
      async (input) => {
        if (input.modelStep !== "supervisor.decision") return;
        if (!holdFirstDecision) return;
        holdFirstDecision = false;
        entered.open();
        await release.waiting;
      },
    );
    cleanups.push(async () => release.open());
    const job = await fixture.createJob();
    const first = await fixture.scheduler.runNow(job.id);
    await fixture.scheduler.tick();
    await entered.waiting;
    const customCompleted: string[] = [];
    const events: EventSinkFactory = {
      create(options) {
        const sink = fixture.application.services.events.create(options);
        const complete = sink.completed.bind(sink);
        sink.completed = (output) => {
          customCompleted.push(options.requestId);
          return complete(output);
        };
        return sink;
      },
    };
    const customHost = fixture.application.host.start({
      eventSinkFactory: events,
    });
    cleanups.push(customHost.stop);
    await customHost.ready;
    release.open();
    await fixture.waitForRun(first.id);
    expect(customCompleted).toEqual([]);

    const second = await fixture.scheduler.runNow(job.id);
    await fixture.scheduler.tick();
    await fixture.waitForRun(second.id);
    expect(customCompleted).toEqual([second.requestId]);

    const defaultHost = fixture.application.host.start();
    cleanups.push(defaultHost.stop);
    await defaultHost.ready;
    const third = await fixture.scheduler.runNow(job.id);
    await fixture.scheduler.tick();
    await fixture.waitForRun(third.id);
    expect(customCompleted).toEqual([second.requestId]);
    expect(
      fixture.events
        .filter((event) => event.type === "completed")
        .map((event) => event.requestId),
    ).toEqual([first.requestId, second.requestId, third.requestId]);
  });
});
