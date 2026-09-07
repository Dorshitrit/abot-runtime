import { afterEach, describe, expect, test, vi } from "vitest";
import type { RuntimeEnvironmentServices } from "../composition.js";
import { startRuntimeHostLifecycle } from "../runtime-host-lifecycle.js";
import { createDefaultRuntimeDependencies } from "../composition.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

vi.mock("../../bridge/start-agent-bridge.js", () => ({
  startAgentBridge: vi.fn(() => ({ stop: async () => {}, getStatus: vi.fn() })),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fixture() {
  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const services = {
    scheduler: {},
    startScheduler: start,
    stopScheduler: stop,
  } as unknown as RuntimeEnvironmentServices;
  const handles: ReturnType<typeof startRuntimeHostLifecycle>[] = [];
  function open(rebound = false) {
    const handle = startRuntimeHostLifecycle(
      rebound ? { ...services } : services,
      undefined,
      () => ({ stop: vi.fn(async () => {}) }),
    );
    handles.push(handle);
    return handle;
  }
  cleanups.push(async () => {
    await Promise.all(handles.map((handle) => handle.stop()));
  });
  return { start, stop, services, open };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

describe("overlapping compatibility host ownership", () => {
  test("the actual default host keeps persisted Jobs usable through its remaining handle", async () => {
    const runtimeFixture = await createSchedulerRuntimeFixture();
    cleanups.push(runtimeFixture.dispose);
    const job = await runtimeFixture.createJob();
    await runtimeFixture.application.stop();
    const runtime = createDefaultRuntimeDependencies(runtimeFixture.config, {
      models: runtimeFixture.application.services.models,
    });
    const first = runtime.host.start();
    const second = runtime.host.start({
      eventSinkFactory: { ...runtime.events },
    });
    cleanups.push(async () => {
      await Promise.all([first.stop(), second.stop()]);
    });
    await Promise.all([first.ready, second.ready]);
    await first.stop();
    await expect(runtime.scheduler!.get(job.id)).resolves.toMatchObject({
      id: job.id,
    });
    await second.stop();
    await expect(runtime.scheduler!.list()).rejects.toThrow(
      "scheduler_not_started",
    );
  });

  test.each([false, true])(
    "stopping one handle keeps the shared scheduler running (rebound=%s)",
    async (rebound) => {
      const state = fixture();
      const first = state.open();
      const second = state.open(rebound);
      await Promise.all([first.ready, second.ready]);
      await first.stop();
      expect(state.stop).not.toHaveBeenCalled();
      expect(state.start).toHaveBeenCalledTimes(1);
      await second.stop();
      expect(state.stop).toHaveBeenCalledTimes(1);
    },
  );

  test("a failed second transport cannot stop the first handle's scheduler", async () => {
    const state = fixture();
    const first = state.open();
    await first.ready;
    expect(() =>
      startRuntimeHostLifecycle(state.services, undefined, () => {
        throw new Error("transport_failed");
      }),
    ).toThrow("transport_failed");
    await Promise.resolve();
    expect(state.stop).not.toHaveBeenCalled();
    await first.stop();
    expect(state.stop).toHaveBeenCalledTimes(1);
  });

  test("stopping one pending handle leaves the sibling startup intact", async () => {
    const state = fixture();
    const startup = deferred();
    cleanups.push(async () => startup.resolve());
    state.start.mockImplementation(() => startup.promise);
    const first = state.open();
    const second = state.open();
    await first.stop();
    expect(state.stop).not.toHaveBeenCalled();
    startup.resolve();
    await expect(first.ready).rejects.toThrow("runtime_host_stopped");
    await expect(second.ready).resolves.toBeUndefined();
    await second.stop();
    expect(state.stop).toHaveBeenCalledTimes(1);
  });

  test("a new group waits for the previous final stop before restarting", async () => {
    const state = fixture();
    const shutdown = deferred();
    cleanups.push(async () => shutdown.resolve());
    const first = state.open();
    await first.ready;
    state.stop.mockImplementationOnce(() => shutdown.promise);
    const closing = first.stop();
    const next = state.open();
    expect(state.start).toHaveBeenCalledTimes(1);
    shutdown.resolve();
    await closing;
    await next.ready;
    expect(state.start).toHaveBeenCalledTimes(2);
    await next.stop();
    expect(state.stop).toHaveBeenCalledTimes(2);
  });

  test("a queued group stopped before the old stop finishes cannot start later", async () => {
    const state = fixture();
    const shutdown = deferred();
    cleanups.push(async () => shutdown.resolve());
    const first = state.open();
    await first.ready;
    state.stop.mockImplementationOnce(() => shutdown.promise);
    const closing = first.stop();
    const abandoned = state.open();
    await abandoned.stop();
    const next = state.open();
    shutdown.resolve();
    await closing;
    await expect(abandoned.ready).rejects.toThrow("runtime_host_stopped");
    await next.ready;
    expect(state.start).toHaveBeenCalledTimes(2);
    await next.stop();
    expect(state.stop).toHaveBeenCalledTimes(2);
  });
});
