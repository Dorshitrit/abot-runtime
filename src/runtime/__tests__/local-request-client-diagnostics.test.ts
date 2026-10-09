import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { LocalRuntimeClientRequests } from "../local-host/client-requests.js";
import type { LocalRuntimeCallHandler } from "../local-host/contracts.js";
import { LocalRuntimeRpcPeer } from "../local-host/rpc-peer.js";
import { processDebugLogger } from "../observability/debug-logger.js";

const traces: { event: string; fields: Record<string, unknown> }[] = [];
beforeEach(() => {
  traces.length = 0;
  vi.spyOn(processDebugLogger, "trace").mockImplementation(
    (_scope, event, fields = {}) => {
      traces.push({ event, fields });
    },
  );
});
afterEach(() => vi.restoreAllMocks());

it("observes acceptance waiting and returns the same owner acknowledgement", async () => {
  let releaseRun!: () => void;
  const running = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const input = { steerId: "steer", text: "PRIVATE_CLIENT_STEERING" };
  const receipt = {
    ok: true,
    duplicate: false,
    update: { ...input, sequence: 1 },
  };
  const call = vi.fn<LocalRuntimeCallHandler>(async (method) => {
    if (method === "request.run") return running;
    return receipt;
  });
  const client = new LocalRuntimeClientRequests(call);
  const request = client.requests.handle(
    { send() {} } as unknown as WebSocket,
    {
      type: "run_request",
      requestId: "request",
      sessionId: "session",
      input: "private request",
    },
  );
  const steering = client.requests.steer!("request", input);
  expect(call.mock.calls.map(([method]) => method)).toEqual(["request.run"]);
  expect(traces.map(({ event }) => event)).toEqual(["steer.client_requested"]);
  await client.handleCallback("request.accepted", ["request"]);
  await expect(steering).resolves.toBe(receipt);
  expect(call).toHaveBeenLastCalledWith("request.steer", ["request", input]);
  expect(traces.map(({ event }) => event)).toEqual([
    "steer.client_requested",
    "steer.client_dispatch_attempted",
    "steer.client_result",
  ]);
  expect(traces[2]!.fields).toMatchObject({
    requestId: "request",
    steerId: "steer",
    sessionId: "session",
    clientStatePresentAtEntry: true,
    clientStatePresentAtDispatch: true,
    clientStateUnchanged: true,
    accepted: true,
    duplicate: false,
    acceptedSequence: 1,
  });
  expect(JSON.stringify(traces)).not.toContain(input.text);
  releaseRun();
  await request;
});

it("keeps missing-client-state delegation and original owner errors", async () => {
  const original = new TypeError("PRIVATE_FAILURE_DETAILS");
  const call = vi
    .fn<LocalRuntimeCallHandler>()
    .mockResolvedValueOnce({ ok: false, reason: "request_not_active" })
    .mockRejectedValueOnce(original);
  const client = new LocalRuntimeClientRequests(call);
  const input = { steerId: "steer", text: "PRIVATE_CLIENT_STEERING" };
  await expect(client.requests.steer!("missing", input)).resolves.toEqual({
    ok: false,
    reason: "request_not_active",
  });
  await expect(client.requests.steer!("missing", input)).rejects.toBe(original);
  expect(call).toHaveBeenCalledTimes(2);
  expect(traces).toContainEqual({
    event: "steer.client_result",
    fields: expect.objectContaining({
      clientStatePresentAtEntry: false,
      clientStatePresentAtDispatch: false,
      accepted: false,
      reason: "request_not_active",
    }),
  });
  expect(traces).toContainEqual({
    event: "steer.client_failed",
    fields: expect.objectContaining({ errorType: "TypeError" }),
  });
  expect(JSON.stringify(traces)).not.toContain(original.message);
  expect(JSON.stringify(traces)).not.toContain(input.text);
});

it("preserves RPC results when diagnostic logging throws", async () => {
  vi.mocked(processDebugLogger.trace).mockImplementation(() => {
    throw new Error("trace unavailable");
  });
  const receipt = { ok: false, reason: "request_not_active" };
  const call = vi.fn<LocalRuntimeCallHandler>().mockResolvedValue(receipt);
  const client = new LocalRuntimeClientRequests(call);
  await expect(
    client.requests.steer!("missing", { steerId: "steer", text: "private" }),
  ).resolves.toBe(receipt);
  expect(call).toHaveBeenCalledOnce();
});

it("records only a dispatch attempt when the RPC transport is already closed", async () => {
  const socket = { on: vi.fn(), send: vi.fn(), terminate: vi.fn() };
  const rpc = new LocalRuntimeRpcPeer(socket as unknown as WebSocket);
  rpc.close();
  const client = new LocalRuntimeClientRequests(rpc.call.bind(rpc));

  await expect(
    client.requests.steer!("request", { steerId: "steer", text: "private" }),
  ).rejects.toThrow("local_runtime_connection_lost");

  expect(socket.send).not.toHaveBeenCalled();
  expect(traces.map(({ event }) => event)).toEqual([
    "steer.client_requested",
    "steer.client_dispatch_attempted",
    "steer.client_failed",
  ]);
});
