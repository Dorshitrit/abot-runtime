import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleManagementRoutes } from "../../web-ui/local-runtime/schedule-management-routes.js";
import {
  createLocalRuntimeApplication,
  type LocalRuntimeApplication,
  type LocalRuntimeApplicationOptions,
} from "../local-application.js";
import type { LocalRuntimeConnection } from "../local-host/contracts.js";
import { createLocalRuntimeConnection } from "../local-host/transport.js";
import {
  createSchedulerRuntimeFixture,
  createSchedulerTestGate,
} from "./support/scheduler-runtime-fixture.js";

vi.mock("../local-host/transport.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../local-host/transport.js")>();
  return {
    ...actual,
    createLocalRuntimeConnection: vi.fn(actual.createLocalRuntimeConnection),
  };
});

const realTransport = await vi.importActual<
  typeof import("../local-host/transport.js")
>("../local-host/transport.js");
const connect = vi.mocked(createLocalRuntimeConnection);
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  connect
    .mockReset()
    .mockImplementation(realTransport.createLocalRuntimeConnection);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createManagedFixture(
  options: LocalRuntimeApplicationOptions = {},
) {
  const fixture = await createSchedulerRuntimeFixture();
  await fixture.application.stop();
  const application = createLocalRuntimeApplication(fixture.config, options);
  cleanups.push(async () => {
    await application.stop().catch(() => undefined);
    await fixture.dispose();
  });
  return { ...fixture, application };
}

async function serveSchedules(application: LocalRuntimeApplication) {
  const routes = new ScheduleManagementRoutes(() => application);
  const server = createServer((request, response) => {
    void routes.handle({
      method: request.method!,
      segments: ["schedules"],
      url: new URL(request.url!, "http://127.0.0.1"),
      body: null,
      environmentId: "dev",
      response,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/schedules`;
}

describe("managed application startup", () => {
  it("deduplicates a failed attempt and allows a later explicit start on the same application", async () => {
    const { application, invoke } = await createManagedFixture();
    const gate = createSchedulerTestGate();
    const failure = new Error("local_runtime_owner_start_timeout");
    connect.mockImplementationOnce(async () => {
      await gate.waiting;
      throw failure;
    });
    const first = application.start();
    const concurrent = application.start();
    const listing = application.services.scheduler.list();
    const attempts = Promise.allSettled([first, concurrent, listing]);
    expect(concurrent).toBe(first);
    expect(connect).toHaveBeenCalledTimes(1);
    gate.open();
    expect(await attempts).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(connect).toHaveBeenCalledTimes(1);

    await application.start();
    expect(await application.services.scheduler.list()).toEqual([]);
    expect(application.getOwnership()).toBe("owner");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("lets a later schedule page GET recover using the same managed application", async () => {
    const { application, invoke } = await createManagedFixture();
    const url = await serveSchedules(application);
    connect.mockRejectedValueOnce(
      new Error("local_runtime_owner_start_timeout"),
    );

    const failed = await fetch(url);
    expect(failed.status).toBe(400);
    expect(await failed.json()).toMatchObject({
      ok: false,
      error: "local_runtime_owner_start_timeout",
    });
    expect(connect).toHaveBeenCalledTimes(1);

    const refreshed = await fetch(url);
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toEqual({ ok: true, jobs: [] });
    expect(connect).toHaveBeenCalledTimes(2);
    const job = await application.services.scheduler.create({
      sessionId: "session",
      title: "Available after explicit refresh",
      prompt: "Run at the scheduled time.",
      modelProfileId: "scheduled-model",
      agentMode: "deep",
      timeZone: "Asia/Jerusalem",
      schedule: { kind: "timer", delayMs: 3_600_000 },
    });
    const loaded = await fetch(url);
    expect(await loaded.json()).toMatchObject({
      ok: true,
      jobs: [{ id: job.id }],
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("allows a later service call to establish the connection without an explicit start", async () => {
    const { application } = await createManagedFixture();
    connect.mockRejectedValueOnce(
      new Error("local_runtime_owner_start_timeout"),
    );
    await expect(application.start()).rejects.toThrow(
      "local_runtime_owner_start_timeout",
    );
    expect(connect).toHaveBeenCalledTimes(1);

    expect(await application.services.scheduler.list()).toEqual([]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("does not revive an application stopped while its initial startup is failing", async () => {
    const { application } = await createManagedFixture();
    const gate = createSchedulerTestGate();
    const failure = new Error("local_runtime_owner_start_timeout");
    connect.mockImplementationOnce(async () => {
      await gate.waiting;
      throw failure;
    });
    const starting = application.start();
    const stopping = application.stop();
    const settled = Promise.allSettled([starting, stopping]);
    gate.open();
    expect(await settled).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    await expect(application.start()).rejects.toThrow("local_runtime_stopped");
    await expect(application.services.scheduler.list()).rejects.toThrow(
      "local_runtime_stopped",
    );
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("never reconnects a previously established application after transport loss", async () => {
    const { application } = await createManagedFixture();
    await application.start();
    const established = (await connect.mock.results[0]!
      .value) as LocalRuntimeConnection;
    expect(await application.services.scheduler.list()).toEqual([]);
    await established.close();

    await application.start();
    await expect(application.services.scheduler.list()).rejects.toThrow(
      "local_runtime_connection_lost",
    );
    await expect(
      application.services.sessions.updateSessionTitle(
        "session",
        "Must not be replayed",
      ),
    ).rejects.toThrow("local_runtime_connection_lost");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("does not replay controls registration when its outcome becomes uncertain after connection establishment", async () => {
    const { application } = await createManagedFixture({
      scheduledRequestOptions: () => ({}),
    });
    const failure = new Error("local_runtime_connection_lost");
    const registration = vi.fn<LocalRuntimeConnection["call"]>();
    connect.mockImplementationOnce(async (options) => {
      const established =
        await realTransport.createLocalRuntimeConnection(options);
      registration.mockImplementation(async (method, args) => {
        await established.call(method, args);
        throw failure;
      });
      return { ...established, call: registration };
    });

    await expect(application.start()).rejects.toBe(failure);
    await expect(application.start()).rejects.toBe(failure);
    await expect(application.services.scheduler.list()).rejects.toBe(failure);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(registration).toHaveBeenCalledExactlyOnceWith(
      "controls.register",
      [],
    );
  });
});
