import type WebSocket from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { createBridgeRequestSteeringRegistry } from "../../bridge/request-steering.js";

const { traceDebug } = vi.hoisted(() => ({ traceDebug: vi.fn() }));
vi.mock("../observability/debug-logger.js", () => ({ traceDebug }));
afterEach(() => traceDebug.mockReset());

function socket(failure?: Error) {
  const frames: unknown[] = [];
  const ws = {
    readyState: 1,
    send(data: string, done: (error?: Error) => void) {
      frames.push(JSON.parse(data));
      done(failure);
    },
  } as unknown as WebSocket;
  return { ws, frames };
}

const message = {
  type: "steer_request",
  requestId: "r",
  steerId: "s",
  text: "private",
};

test("retains missing-request rejection and records it before ACK transport failure", async () => {
  const steer = vi.fn();
  const registry = createBridgeRequestSteeringRegistry(steer);
  const error = new Error("connection failed");
  const { ws, frames } = socket(error);
  await expect(registry.handleMessage(ws, message)).rejects.toBe(error);
  expect(steer).not.toHaveBeenCalled();
  expect(frames).toEqual([
    {
      type: "steer_ack",
      requestId: "r",
      steerId: "s",
      accepted: false,
      reason: "request_not_active",
    },
  ]);
  expect(traceDebug).toHaveBeenCalledWith(
    "agent-bridge.request_steering",
    "message.rejected",
    expect.objectContaining({
      registryPresent: false,
      requestId: "r",
      steerId: "s",
    }),
  );
  expect(traceDebug).toHaveBeenCalledWith(
    "agent-bridge.request_steering",
    "ack.dispatch_failed",
    expect.objectContaining({ errorType: "Error" }),
  );
  expect(JSON.stringify(traceDebug.mock.calls)).not.toContain(message.text);
});

test("owner acceptance and callback order survive a broken logger", async () => {
  traceDebug.mockImplementation(() => {
    throw new Error("logger unavailable");
  });
  const steer = vi.fn(async () => ({
    ok: true as const,
    duplicate: false,
    update: { steerId: "s", text: "private", sequence: 3 },
  }));
  const registry = createBridgeRequestSteeringRegistry(steer);
  const inbox = registry.open("r");
  const { ws, frames } = socket();
  await expect(registry.handleMessage(ws, message)).resolves.toBe(true);
  expect(steer).toHaveBeenCalledExactlyOnceWith("r", {
    steerId: "s",
    text: "private",
  });
  expect(frames).toEqual([
    {
      type: "steer_ack",
      requestId: "r",
      steerId: "s",
      accepted: true,
      acceptedSequence: 3,
    },
  ]);
  await registry.close("r", inbox);
});
