import { afterEach, describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import type {
  RuntimeEnvironmentServices,
  RuntimeRequestHandler,
} from "../composition.js";
import { startRuntimeHostLifecycle } from "../runtime-host-lifecycle.js";

afterEach(() => vi.restoreAllMocks());

function lifecycleFixture(steer?: RuntimeRequestHandler["steer"]) {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const startup = new Promise<void>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  const startScheduler = vi.fn(() => startup);
  const stopScheduler = vi.fn(async () => undefined);
  const transportStop = vi.fn(async () => undefined);
  const handle = vi.fn<RuntimeRequestHandler["handle"]>(async () => undefined);
  let gated!: RuntimeRequestHandler;
  const host = startRuntimeHostLifecycle(
    { startScheduler, stopScheduler } as unknown as RuntimeEnvironmentServices,
    { handle, ...(steer ? { steer } : {}) },
    (requests) => {
      gated = requests!;
      return { stop: transportStop };
    },
  );
  return {
    host,
    gated,
    resolve,
    reject,
    startScheduler,
    stopScheduler,
    transportStop,
    handle,
  };
}

describe("synchronous host with asynchronous scheduler startup", () => {
  test("keeps steering absent when the original handler does not provide it", async () => {
    const fixture = lifecycleFixture();
    fixture.resolve();
    await fixture.host.ready;
    expect(fixture.gated).not.toHaveProperty("steer");
    await fixture.host.stop();
  });

  test("gates steering until readiness and delegates a queued request before its steering", async () => {
    let active = false;
    const steer = vi.fn<NonNullable<RuntimeRequestHandler["steer"]>>(
      async (_requestId, input) => {
        if (!active) return { ok: false, reason: "request_not_active" };
        return {
          ok: true,
          duplicate: false,
          update: { ...input, sequence: 1 },
        };
      },
    );
    const fixture = lifecycleFixture(steer);
    fixture.handle.mockImplementation(async () => {
      active = true;
    });
    const request = fixture.gated.handle({} as WebSocket, {
      type: "run_request",
      requestId: "queued-request",
    });
    const update = fixture.gated.steer!("queued-request", {
      steerId: "queued-steering",
      text: "Additional request instruction",
    });
    await Promise.resolve();
    expect(steer).not.toHaveBeenCalled();
    fixture.resolve();
    await request;
    await expect(update).resolves.toMatchObject({ ok: true });
    expect(steer).toHaveBeenCalledOnce();
    await fixture.host.stop();
    await expect(
      fixture.gated.steer!("queued-request", {
        steerId: "after-stop",
        text: "Too late",
      }),
    ).rejects.toThrow("runtime_host_stopped");
    expect(steer).toHaveBeenCalledOnce();
  });

  test("startup failure rejects waiting steering without calling its handler", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const steer = vi.fn<NonNullable<RuntimeRequestHandler["steer"]>>(
      async () => ({ ok: false, reason: "request_not_active" }),
    );
    const fixture = lifecycleFixture(steer);
    const update = fixture.gated.steer!("pending-request", {
      steerId: "pending-steer",
      text: "Additional instruction",
    });
    const rejected = expect(update).rejects.toThrow("scheduler_store_in_use");
    fixture.reject(new Error("scheduler_store_in_use"));
    await rejected;
    expect(steer).not.toHaveBeenCalled();
    await fixture.host.stop();
  });

  test("stop during startup prevents waiting steering from entering the handler", async () => {
    const steer = vi.fn<NonNullable<RuntimeRequestHandler["steer"]>>(
      async () => ({ ok: false, reason: "request_not_active" }),
    );
    const fixture = lifecycleFixture(steer);
    const update = fixture.gated.steer!("pending-request", {
      steerId: "pending-steer",
      text: "Additional instruction",
    });
    const rejected = expect(update).rejects.toThrow("runtime_host_stopped");
    await fixture.host.stop();
    fixture.resolve();
    await rejected;
    expect(steer).not.toHaveBeenCalled();
  });

  test.each(["prototype", "non-enumerable own"] as const)(
    "forwards %s canonical steering with its original receiver",
    async (location) => {
      class InjectedRequestHandler {
        readonly requestId = "canonical-request";
        async handle() {}
        async steer(
          requestId: string,
          input: { steerId: string; text: string },
        ) {
          expect(requestId).toBe(this.requestId);
          return {
            ok: true as const,
            duplicate: false,
            update: { ...input, sequence: 1 },
          };
        }
      }
      const requests = new InjectedRequestHandler();
      if (location === "non-enumerable own") {
        Object.defineProperty(requests, "steer", {
          value: requests.steer,
          enumerable: false,
        });
      }
      let forwarded!: RuntimeRequestHandler;
      const host = startRuntimeHostLifecycle(
        undefined,
        requests,
        (readyRequests) => {
          forwarded = readyRequests!;
          return { stop: async () => undefined };
        },
      );
      try {
        await host.ready;
        expect(forwarded.steer).toBeTypeOf("function");
        await expect(
          forwarded.steer!("canonical-request", {
            steerId: "steer",
            text: "Continue",
          }),
        ).resolves.toMatchObject({
          ok: true,
          update: { sequence: 1, steerId: "steer" },
        });
      } finally {
        await host.stop();
      }
    },
  );

  test("starts immediately, gates requests on readiness and keeps bare stop idempotent", async () => {
    const fixture = lifecycleFixture();
    expect(fixture.startScheduler).toHaveBeenCalledOnce();
    const request = fixture.gated.handle({} as WebSocket, {
      type: "run_request",
      requestId: "gated",
    });
    await Promise.resolve();
    expect(fixture.handle).not.toHaveBeenCalled();
    fixture.resolve();
    await fixture.host.ready;
    await request;
    expect(fixture.handle).toHaveBeenCalledOnce();
    const stop = fixture.host.stop;
    await Promise.all([stop(), stop()]);
    expect(fixture.stopScheduler).toHaveBeenCalledOnce();
    expect(fixture.transportStop).toHaveBeenCalledOnce();
    await expect(
      fixture.gated.handle({} as WebSocket, {
        type: "run_request",
        requestId: "stopped",
      }),
    ).rejects.toThrow("runtime_host_stopped");
  });

  test("startup failure closes transport and scheduler even if the consumer ignores ready", async () => {
    const report = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fixture = lifecycleFixture();
    fixture.reject(new Error("scheduler_store_in_use"));
    await vi.waitFor(() =>
      expect(fixture.transportStop).toHaveBeenCalledOnce(),
    );
    expect(fixture.stopScheduler).toHaveBeenCalledOnce();
    await expect(fixture.host.ready).rejects.toThrow("scheduler_store_in_use");
    await expect(
      fixture.gated.handle({} as WebSocket, {
        type: "run_request",
        requestId: "failed",
      }),
    ).rejects.toThrow("scheduler_store_in_use");
    expect(fixture.handle).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      "Runtime host startup failed:",
      expect.any(Error),
    );
  });

  test("stop during startup prevents request execution and still closes both resources", async () => {
    const fixture = lifecycleFixture();
    await fixture.host.stop();
    fixture.resolve();
    await expect(fixture.host.ready).rejects.toThrow("runtime_host_stopped");
    expect(fixture.transportStop).toHaveBeenCalledOnce();
    expect(fixture.stopScheduler).toHaveBeenCalledOnce();
    expect(fixture.handle).not.toHaveBeenCalled();
  });

  test("transport construction failure releases a scheduler that already started", async () => {
    const stopScheduler = vi.fn(async () => undefined);
    expect(() =>
      startRuntimeHostLifecycle(
        {
          startScheduler: () => Promise.resolve(),
          stopScheduler,
        } as unknown as RuntimeEnvironmentServices,
        undefined,
        () => {
          throw new Error("bridge_configuration_invalid");
        },
      ),
    ).toThrow("bridge_configuration_invalid");
    await vi.waitFor(() => expect(stopScheduler).toHaveBeenCalledOnce());
  });
});
