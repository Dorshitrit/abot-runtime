import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type WebSocket from "ws";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as debug from "../observability/debug-logger.js";
import { LocalRealtimeController } from "../../web-ui/local-runtime/realtime-controller.js";
import { LocalRequestExecution } from "../../web-ui/local-runtime/request-execution.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";
import type { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";
import { cancelWebRequest } from "../../web-ui/local-runtime/request-cancellation-route.js";

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

function transportFixture(environment: unknown) {
  const get = vi.fn(() => environment);
  const sent: Record<string, unknown>[] = [];
  const socket = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    send: vi.fn((raw: string) => sent.push(JSON.parse(raw))),
  });
  const clients = new RealtimeClientHub();
  const requests = new LocalRequestExecution(clients);
  const controller = new LocalRealtimeController(
    { defaultEnvironmentId: "dev" },
    { get } as unknown as RuntimeEnvironmentRegistry,
    requests,
    clients,
  );
  controller.connect(socket as unknown as WebSocket);
  return {
    get,
    sent,
    socket,
    emit: (message: unknown) => socket.emit("message", JSON.stringify(message)),
  };
}

test("steer dispatch retains its exact acknowledgement without claiming browser delivery", async () => {
  const f = transportFixture({});
  f.emit({
    type: "steer_request",
    requestId: "missing",
    steerId: "update",
    text: "private text",
  });
  await vi.waitFor(() => expect(f.sent).toHaveLength(1));
  expect(f.sent).toEqual([
    {
      type: "steer_ack",
      requestId: "missing",
      steerId: "update",
      accepted: false,
      reason: "request_not_active",
    },
  ]);
  expect(f.get).not.toHaveBeenCalled();
  expect(diagnostic("steer.ack_dispatch_attempted")).toEqual([
    expect.objectContaining({
      requestId: "missing",
      steerId: "update",
      socketReadyState: 1,
    }),
  ]);
});

test("a closed socket still drops acknowledgement delivery with only an attempted-dispatch trace", async () => {
  const f = transportFixture({});
  f.socket.readyState = 3;
  f.emit({
    type: "steer_request",
    requestId: "missing",
    steerId: "update",
    text: "update",
  });
  await vi.waitFor(() =>
    expect(diagnostic("steer.ack_dispatch_attempted")).toHaveLength(1),
  );
  expect(f.socket.send).not.toHaveBeenCalled();
  expect(diagnostic("steer.ack_dispatch_attempted")[0]).toMatchObject({
    socketReadyState: 3,
  });
});

test("resume reports the existing replay result without additional reads or changed frames", async () => {
  const event = {
    type: "token",
    requestId: "request",
    sessionId: "session",
    text: "private answer",
    seqNo: 4,
  };
  const getRequestReplayById = vi.fn(async () => ({
    sessionId: "session",
    events: [event],
    lifecycle: { status: "completed" },
    finalState: { status: "completed", output: "private answer" },
  }));
  const f = transportFixture({
    services: { sessions: { getRequestReplayById } },
  });
  f.emit({
    type: "resume_request",
    requestId: "request",
    afterSeq: 3,
    environment: "dev",
  });
  await vi.waitFor(() => expect(f.sent).toHaveLength(2));
  expect(f.get).toHaveBeenCalledExactlyOnceWith("dev");
  expect(getRequestReplayById).toHaveBeenCalledExactlyOnceWith("request", 3);
  expect(f.sent).toEqual([
    { ...event, environment: "dev" },
    {
      type: "completed",
      requestId: "request",
      sessionId: "session",
      environment: "dev",
      output: "private answer",
    },
  ]);
  expect(diagnostic("resume.dispatch_returned")).toEqual([
    expect.objectContaining({
      requestId: "request",
      afterSeq: 3,
      replayFound: true,
      eventCount: 1,
      lifecycleStatus: "completed",
      finalStateStatus: "completed",
    }),
  ]);
  expect(JSON.stringify(diagnostic("resume.dispatch_returned"))).not.toContain(
    "private answer",
  );
});

test("missing replay keeps the existing two reads and approval lookup without new recovery", async () => {
  const getRequestReplayById = vi.fn(async () => null);
  const list = vi.fn(async () => []);
  const f = transportFixture({
    services: { sessions: { getRequestReplayById } },
    approvals: { list },
  });
  f.emit({
    type: "resume_request",
    requestId: "missing",
    afterSeq: 9,
    environment: "dev",
  });
  await vi.waitFor(() =>
    expect(diagnostic("resume.dispatch_returned")).toHaveLength(1),
  );
  expect(getRequestReplayById.mock.calls).toEqual([
    ["missing", 9],
    ["missing", 9],
  ]);
  expect(list).toHaveBeenCalledOnce();
  expect(f.sent).toEqual([]);
  expect(diagnostic("resume.dispatch_returned")[0]).toMatchObject({
    replayFound: false,
    eventCount: 0,
  });
});

function cancellationFixture(
  cancel: (
    requestId: string,
    sessionId: string,
    wait: unknown,
  ) => Promise<unknown>,
) {
  const payloads: unknown[] = [];
  return {
    payloads,
    input: {
      request: {
        headers: { "content-type": "application/json" },
      } as IncomingMessage,
      response: {
        writeHead: vi.fn(),
        end: (raw: string) => payloads.push(JSON.parse(raw)),
      } as unknown as ServerResponse,
      environment: {
        services: { config: { runtimeId: "dev" } },
        requests: { cancel },
      } as unknown as RuntimeEnvironment,
      body: { requestId: "request", sessionId: "session" },
    },
  };
}

test.each([
  { accepted: true },
  { accepted: false, reason: "request_not_active" },
])("cancellation logs preserve owner call and response %j", async (result) => {
  const cancel = vi.fn(async () => result);
  const f = cancellationFixture(cancel);
  await cancelWebRequest(f.input);
  expect(cancel).toHaveBeenCalledExactlyOnceWith(
    "request",
    "session",
    undefined,
  );
  expect(f.payloads).toEqual([{ ok: true, ...result }]);
  expect(diagnostic("cancel.result")).toEqual([
    expect.objectContaining({
      requestId: "request",
      sessionId: "session",
      environmentId: "dev",
      ...result,
    }),
  ]);
});

test("cancellation failure preserves the thrown object even when trace logging fails", async () => {
  const failure = new TypeError("private failure");
  const cancel = vi.fn(async () => {
    throw failure;
  });
  const f = cancellationFixture(cancel);
  await expect(cancelWebRequest(f.input)).rejects.toBe(failure);
  expect(diagnostic("cancel.failed")).toEqual([
    expect.objectContaining({ errorType: "TypeError" }),
  ]);
  expect(f.payloads).toEqual([]);
  vi.mocked(debug.traceDebug).mockImplementation(() => {
    throw new Error("trace unavailable");
  });
  await expect(cancelWebRequest(f.input)).rejects.toBe(failure);
  expect(f.payloads).toEqual([]);
});
