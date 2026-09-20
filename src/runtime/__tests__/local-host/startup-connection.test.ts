import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { connectToRuntimeOwner } from "../../local-host/startup-connection.js";
import type { LocalRuntimeEndpoint } from "../../local-host/contracts.js";

type HandshakeSocket = EventEmitter & {
  readyState: number;
  terminate: ReturnType<typeof vi.fn>;
};
const fixture = vi.hoisted(() => ({ sockets: [] as HandshakeSocket[] }));
vi.mock("ws", async (original) => {
  const actual = await original<typeof import("ws")>();
  const { EventEmitter } = await import("node:events");
  class ControlledHandshakeSocket extends EventEmitter {
    static OPEN = actual.default.OPEN;
    readyState: number = actual.default.CONNECTING;
    terminate = vi.fn(() => {
      this.readyState = actual.default.CLOSED;
      // A real CONNECTING socket emits an abort error when terminated.
      this.emit(
        "error",
        new Error("WebSocket was closed before the connection was established"),
      );
      this.emit("close");
    });
    constructor() {
      super();
      fixture.sockets.push(this);
    }
  }
  return { ...actual, default: ControlledHandshakeSocket };
});

const endpoint: LocalRuntimeEndpoint = {
  version: 1,
  identity: "fixture-environment",
  pid: process.pid,
  port: 12345,
  token: "fixture-token",
};
beforeEach(() => {
  fixture.sockets = [];
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function currentSocket(): HandshakeSocket {
  expect(fixture.sockets).toHaveLength(1);
  return fixture.sockets[0]!;
}

function expectStartupListenersRemoved(socket: HandshakeSocket): void {
  expect(socket.listenerCount("open")).toBe(0);
  // The established RPC peer retains its error handler for late abort errors.
  expect(socket.listenerCount("error")).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
}

test("a silent handshake rejects at the original absolute deadline and releases its timer", async () => {
  const pending = connectToRuntimeOwner(endpoint, 1250);
  const settled = vi.fn();
  void pending.then(settled, settled);
  const rejected = expect(pending).rejects.toThrow(
    "local_runtime_owner_start_timeout",
  );
  const socket = currentSocket();
  await vi.advanceTimersByTimeAsync(249);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(socket.terminate).toHaveBeenCalledOnce();
  expectStartupListenersRemoved(socket);
});

test("a successful handshake clears the timer and retains the peer past the startup deadline", async () => {
  const pending = connectToRuntimeOwner(endpoint, 1250);
  const socket = currentSocket();
  socket.readyState = 1;
  socket.emit("open");
  const peer = await pending;
  const closed = vi.fn();
  peer.onClose(closed);
  expectStartupListenersRemoved(socket);
  await vi.advanceTimersByTimeAsync(1000);
  expect(socket.terminate).not.toHaveBeenCalled();
  expect(closed).not.toHaveBeenCalled();
  peer.close();
});

test("a late open cannot beat an expired deadline when its timer callback has not run", async () => {
  const pending = connectToRuntimeOwner(endpoint, 1250);
  const rejected = expect(pending).rejects.toThrow(
    "local_runtime_owner_start_timeout",
  );
  const socket = currentSocket();
  vi.setSystemTime(1251);
  socket.readyState = 1;
  socket.emit("open");
  await rejected;
  expect(socket.terminate).toHaveBeenCalledOnce();
  expectStartupListenersRemoved(socket);
});

test("authentication errors remain terminal and are not replaced by a later timeout or abort error", async () => {
  const pending = connectToRuntimeOwner(endpoint, 1250);
  const authenticationError = new Error("Unexpected server response: 401");
  const rejected = expect(pending).rejects.toBe(authenticationError);
  const socket = currentSocket();
  socket.emit("error", authenticationError);
  await rejected;
  expect(socket.terminate).toHaveBeenCalledOnce();
  expectStartupListenersRemoved(socket);
  await vi.advanceTimersByTimeAsync(1000);
  expect(socket.terminate).toHaveBeenCalledOnce();
});

test("an exhausted deadline fails before creating a socket or timer", async () => {
  await expect(connectToRuntimeOwner(endpoint, 1000)).rejects.toThrow(
    "local_runtime_owner_start_timeout",
  );
  expect(fixture.sockets).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
