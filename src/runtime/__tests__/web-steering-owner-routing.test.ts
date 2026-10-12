import { afterEach, expect, test, vi } from "vitest";
import { AutomationSessionLockedError } from "../../sessions/automation-session-origin.js";
import { LocalRequestExecution } from "../../web-ui/local-runtime/request-execution.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import type { RequestSteeringAppendResult } from "../request/request-steering.js";
import * as debug from "../observability/debug-logger.js";

const message = {
  requestId: "resumed-request",
  steerId: "steer",
  environment: "prod",
  text: "Private revised instruction",
};
const accepted = {
  ok: true,
  duplicate: false,
  update: { steerId: "steer", sequence: 3, text: message.text },
} as const;
const inactive = { ok: false, reason: "request_not_active" } as const;
function environment(steer?: () => Promise<RequestSteeringAppendResult>) {
  return {
    services: { sessions: { assertInteractiveSession: vi.fn() } },
    requests: { steer },
  } as unknown as RuntimeEnvironment;
}
afterEach(() => vi.restoreAllMocks());

test("a missing Web projection routes once to the explicitly selected owner and preserves its receipt", async () => {
  const trace = vi.spyOn(debug, "traceDebug").mockImplementation(() => {});
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  const steer = vi.fn(async () => accepted);
  const resolve = vi.fn(() => environment(steer));
  expect(await requests.handleSteer(message, resolve)).toEqual({
    type: "steer_ack",
    requestId: message.requestId,
    steerId: message.steerId,
    accepted: true,
    acceptedSequence: 3,
  });
  expect(resolve).toHaveBeenCalledExactlyOnceWith("prod");
  expect(steer).toHaveBeenCalledExactlyOnceWith(message.requestId, {
    steerId: message.steerId,
    text: message.text,
  });
  expect(requests.healthDetails()).toEqual([]);
  const result = trace.mock.calls.find(
    ([scope, event]) =>
      scope === "web.request_control" && event === "steer.result",
  );
  expect(result?.[2]).toMatchObject({
    route: "runtime_owner",
    projectionPresent: false,
    currentProjectionPresent: false,
    accepted: true,
  });
  expect(JSON.stringify(trace.mock.calls)).not.toContain(message.text);
});

test.each([undefined, "", "  "])(
  "missing explicit environment %j cannot guess or search for a request owner",
  async (environmentId) => {
    const requests = new LocalRequestExecution(new RealtimeClientHub());
    const resolve = vi.fn(() => environment(async () => accepted));
    expect(
      await requests.handleSteer(
        { ...message, environment: environmentId },
        resolve,
      ),
    ).toMatchObject({ accepted: false, reason: "request_not_active" });
    expect(resolve).not.toHaveBeenCalled();
  },
);

test("a wrong existing environment is authoritative for rejection; other owners are never searched", async () => {
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  const steer = vi.fn(async () => inactive);
  const resolve = vi.fn(() => environment(steer));
  expect(
    await requests.handleSteer({ ...message, environment: "other" }, resolve),
  ).toMatchObject({ accepted: false, reason: "request_not_active" });
  expect(resolve).toHaveBeenCalledExactlyOnceWith("other");
  expect(steer).toHaveBeenCalledOnce();
  expect(requests.healthDetails()).toEqual([]);
});

test.each(["request_not_active", "steer_id_conflict", "invalid_steer_request"])(
  "owner rejection %s never falls back to a local inbox",
  async (reason) => {
    const requests = new LocalRequestExecution(new RealtimeClientHub());
    const result = { ok: false, reason } as RequestSteeringAppendResult;
    const steer = vi.fn(async () => result);
    expect(
      await requests.handleSteer(message, () => environment(steer)),
    ).toMatchObject({
      accepted: false,
      reason,
    });
    expect(steer).toHaveBeenCalledOnce();
    expect(requests.healthDetails()).toEqual([]);
  },
);

test("without an owner method or a projection, no local inbox is invented", async () => {
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  expect(
    await requests.handleSteer(message, () => environment()),
  ).toMatchObject({
    accepted: false,
    reason: "request_not_active",
  });
  expect(requests.healthDetails()).toEqual([]);
});

test("unknown environments and owner transport failures preserve the original exception", async () => {
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  const failure = new Error("environment_unavailable");
  const resolve = vi.fn(() => {
    throw failure;
  });
  await expect(requests.handleSteer(message, resolve)).rejects.toBe(failure);
  expect(resolve).toHaveBeenCalledExactlyOnceWith("prod");
  const steer = vi.fn(async () => {
    throw failure;
  });
  await expect(
    requests.handleSteer(message, () => environment(steer)),
  ).rejects.toBe(failure);
  expect(steer).toHaveBeenCalledOnce();
});

test("an automation lock from the canonical owner retains the existing rejection acknowledgement", async () => {
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  const steer = vi.fn(async () => {
    throw new AutomationSessionLockedError();
  });
  expect(await requests.handleSteer(message, () => environment(steer))).toEqual(
    {
      type: "steer_ack",
      requestId: message.requestId,
      steerId: message.steerId,
      accepted: false,
      reason: "automation_session_locked",
    },
  );
  expect(steer).toHaveBeenCalledOnce();
});

test("a captured scheduled projection keeps its own environment and local-only inbox behavior", async () => {
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  const options = requests.scheduledRequestOptions({
    requestId: message.requestId,
    sessionId: "session",
    environmentId: "captured",
  } as SchedulerRun);
  const resolve = vi.fn(() => environment());
  expect(await requests.handleSteer(message, resolve)).toMatchObject({
    accepted: true,
    acceptedSequence: 1,
  });
  expect(resolve.mock.calls).toEqual([["captured"], ["captured"]]);
  expect(options.requestSteering!.snapshot().version).toBe(1);
});
