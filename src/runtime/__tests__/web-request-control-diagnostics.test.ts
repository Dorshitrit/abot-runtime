import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as debug from "../observability/debug-logger.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import type { RequestSteeringAppendResult } from "../request/request-steering.js";
import { LocalRequestExecution } from "../../web-ui/local-runtime/request-execution.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";

beforeEach(() => {
  vi.spyOn(debug, "traceDebug").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function diagnostic(event: string) {
  return vi
    .mocked(debug.traceDebug)
    .mock.calls.filter(
      ([scope, name]) => scope === "web.request_control" && name === event,
    )
    .map(([, , fields]) => fields);
}

const run = {
  requestId: "request",
  sessionId: "session",
  environmentId: "dev",
} as SchedulerRun;
const message = {
  requestId: "request",
  steerId: "steer",
  environment: "dev",
  text: "private update",
};
const declined = { ok: false, reason: "request_not_active" } as const;
const accepted = {
  ok: true,
  duplicate: false,
  update: { steerId: "steer", sequence: 7, text: message.text },
} as const;

function environment(steer?: () => Promise<RequestSteeringAppendResult>) {
  return {
    services: { sessions: { assertInteractiveSession: vi.fn(async () => {}) } },
    requests: { steer },
  } as unknown as RuntimeEnvironment;
}

function responseFixture() {
  const payload: Record<string, unknown>[] = [];
  return {
    payload,
    response: {
      writeHead: vi.fn(),
      end: (raw: string) => payload.push(JSON.parse(raw)),
    } as unknown as ServerResponse,
  };
}

test("a missing Web projection is distinguished without querying the owner", async () => {
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  const resolve = vi.fn(() => environment());
  await expect(requests.handleSteer(message, resolve)).resolves.toEqual({
    type: "steer_ack",
    requestId: "request",
    steerId: "steer",
    accepted: false,
    reason: "request_not_active",
  });
  expect(resolve).not.toHaveBeenCalled();
  expect(diagnostic("steer.received")).toEqual([
    expect.objectContaining({
      projectionPresent: false,
      requestedEnvironment: "dev",
      textLength: message.text.length,
    }),
  ]);
  expect(diagnostic("steer.result")).toEqual([
    expect.objectContaining({
      route: "web_projection_missing",
      projectionPresent: false,
      accepted: false,
      reason: "request_not_active",
    }),
  ]);
});

test.each([declined, accepted])(
  "owner result remains unchanged and content stays outside diagnostics: %j",
  async (result) => {
    const requests = new LocalRequestExecution(new RealtimeClientHub());
    requests.scheduledRequestOptions(run);
    const steer = vi.fn(async () => result);
    const owner = environment(steer);
    const resolve = vi.fn(() => owner);
    const acknowledgement = await requests.handleSteer(message, resolve);
    expect(acknowledgement).toEqual(
      result.ok
        ? {
            type: "steer_ack",
            requestId: "request",
            steerId: "steer",
            accepted: true,
            acceptedSequence: 7,
          }
        : {
            type: "steer_ack",
            requestId: "request",
            steerId: "steer",
            accepted: false,
            reason: "request_not_active",
          },
    );
    expect(resolve.mock.calls).toEqual([["dev"], ["dev"]]);
    expect(steer).toHaveBeenCalledExactlyOnceWith("request", {
      steerId: "steer",
      text: message.text,
    });
    expect(
      owner.services.sessions.assertInteractiveSession,
    ).toHaveBeenCalledExactlyOnceWith("session");
    expect(diagnostic("steer.result")).toEqual([
      expect.objectContaining({
        route: "runtime_owner",
        projectionPresent: true,
        projectionStillCurrent: true,
        accepted: result.ok,
      }),
    ]);
    expect(
      JSON.stringify(vi.mocked(debug.traceDebug).mock.calls),
    ).not.toContain(message.text);
  },
);

test("projection replacement during owner await is observed without changing the accepted update", async () => {
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  requests.scheduledRequestOptions(run);
  let finish!: (result: RequestSteeringAppendResult) => void;
  const steer = vi.fn(
    () =>
      new Promise<RequestSteeringAppendResult>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = requests.handleSteer(message, () => environment(steer));
  await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce());
  const replacement = requests.scheduledRequestOptions(run).requestSteering!;
  finish(accepted);
  await expect(pending).resolves.toMatchObject({
    accepted: true,
    acceptedSequence: 7,
  });
  expect(replacement.snapshot().version).toBe(0);
  expect(diagnostic("steer.result")).toEqual([
    expect.objectContaining({
      route: "runtime_owner",
      currentProjectionPresent: true,
      projectionStillCurrent: false,
    }),
  ]);
});

test("owner exceptions and synchronous trace failures preserve control outcomes", async () => {
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  requests.scheduledRequestOptions(run);
  const failure = new TypeError("private transport failure");
  const steer = vi.fn(async () => {
    throw failure;
  });
  await expect(
    requests.handleSteer(message, () => environment(steer)),
  ).rejects.toBe(failure);
  expect(diagnostic("steer.failed")).toEqual([
    expect.objectContaining({
      route: "runtime_owner",
      errorType: "TypeError",
    }),
  ]);
  expect(JSON.stringify(diagnostic("steer.failed"))).not.toContain(
    failure.message,
  );
  vi.mocked(debug.traceDebug).mockImplementation(() => {
    throw new Error("trace unavailable");
  });
  await expect(
    requests.handleSteer(message, () => environment(async () => accepted)),
  ).resolves.toMatchObject({ accepted: true, acceptedSequence: 7 });
  await expect(
    requests.handleSteer(message, () => environment(steer)),
  ).rejects.toBe(failure);
});

test("fallback inbox routing and scheduled cleanup retain their existing behavior", async () => {
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  const options = requests.scheduledRequestOptions(run);
  await expect(
    requests.handleSteer(message, () => environment()),
  ).resolves.toEqual({
    type: "steer_ack",
    requestId: "request",
    steerId: "steer",
    accepted: true,
    acceptedSequence: 1,
  });
  expect(options.requestSteering!.snapshot().version).toBe(1);
  expect(diagnostic("steer.result")[0]).toMatchObject({ route: "local_inbox" });
  requests.publishScheduled({
    type: "completed",
    requestId: "request",
    output: "private answer",
  });
  expect(requests.healthDetails()).toEqual([]);
  expect(diagnostic("projection.removed")).toEqual([
    expect.objectContaining({
      requestId: "request",
      reason: "published_terminal",
      removed: true,
      finalStateStatus: "completed",
    }),
  ]);
});

test("ordinary projection cleanup waits for handle settlement and does not label a parked run completed", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handle = vi.fn(() => pending);
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  const owner = {
    ...environment(),
    requests: { handle },
  } as unknown as RuntimeEnvironment;
  const { response, payload } = responseFixture();
  await requests.start(
    response,
    { sessionId: "session", text: "private prompt" },
    "dev",
    owner,
  );
  expect(handle).toHaveBeenCalledOnce();
  expect(requests.healthDetails()).toHaveLength(1);
  expect(diagnostic("projection.removed")).toEqual([]);
  finish();
  await vi.waitFor(() => expect(requests.healthDetails()).toEqual([]));
  expect(diagnostic("projection.removed")).toEqual([
    expect.objectContaining({
      requestId: payload[0].requestId,
      reason: "run_handle_settled",
      removed: true,
      finalStateStatus: undefined,
    }),
  ]);
});

test("Planner display titles remain outside steer and projection cleanup diagnostics", async () => {
  const privateTitle = "Private customer acquisition plan";
  const privateDisplayName = `Planner started: ${privateTitle}`;
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  requests.scheduledRequestOptions(run);
  requests.publishScheduled({
    type: "event",
    requestId: run.requestId,
    name: privateDisplayName,
  });
  await expect(
    requests.handleSteer(message, () => environment()),
  ).resolves.toMatchObject({
    accepted: true,
    acceptedSequence: 1,
  });
  requests.publishScheduled({
    type: "completed",
    requestId: run.requestId,
    output: "private result",
  });
  expect(requests.healthDetails()).toEqual([]);
  expect(diagnostic("steer.received")).toHaveLength(1);
  expect(diagnostic("steer.result")).toHaveLength(1);
  expect(diagnostic("projection.removed")).toHaveLength(1);
  const logs = JSON.stringify(vi.mocked(debug.traceDebug).mock.calls);
  expect(logs).not.toContain(privateTitle);
  expect(logs).not.toContain(privateDisplayName);
  expect(logs).not.toContain("private result");
});
