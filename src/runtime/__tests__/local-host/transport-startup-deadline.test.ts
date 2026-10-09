import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import { acquireFileLock } from "../../adapters/long-term-memory/file-lock/acquisition.js";
import type { LocalRuntimeEndpoint } from "../../local-host/contracts.js";
import { readLocalRuntimeEndpoint } from "../../local-host/endpoint.js";
import { createLocalRuntimeConnection } from "../../local-host/transport.js";

type HandshakeSocket = EventEmitter & {
  readyState: number;
  terminate: Mock<() => void>;
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
vi.mock("../../adapters/long-term-memory/file-lock/acquisition.js", () => ({
  acquireFileLock: vi.fn(async () => {
    throw new Error("long_term_memory_store_lock_timeout");
  }),
}));
vi.mock("../../local-host/endpoint.js", async (original) => {
  const actual = await original<typeof import("../../local-host/endpoint.js")>();
  return {
    ...actual,
    ensurePrivateRuntimeDirectory: vi.fn(async () => {}),
    readLocalRuntimeEndpoint: vi.fn(async () => endpoint),
    isLocalRuntimeProcessAlive: vi.fn(() => true),
  };
});

const endpoint: LocalRuntimeEndpoint = {
  version: 1,
  identity: "fixture-environment",
  pid: process.pid,
  port: 12345,
  token: "fixture-token",
};
beforeEach(() => {
  const now = Date.now();
  fixture.sockets = [];
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  for (const socket of fixture.sockets) {
    if (!socket.terminate.mock.calls.length) socket.terminate();
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("repeated pre-handshake connection loss remains bounded by the initial startup deadline", async () => {
  const createOwner = vi.fn(async () => {
    throw new Error("unexpected replacement owner");
  });
  const pending = createLocalRuntimeConnection({
    directory: "fixture-runtime-directory",
    identity: endpoint.identity,
    startupTimeoutMs: 250,
    createOwner,
  });
  const settled = vi.fn();
  void pending.then(settled, settled);
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.sockets).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(100);
  fixture.sockets[0]!.emit(
    "error",
    Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
  );
  await vi.advanceTimersByTimeAsync(25);
  expect(fixture.sockets).toHaveLength(2);
  expect(fixture.sockets[0]!.terminate).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(75);
  fixture.sockets[1]!.emit(
    "error",
    Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
  );
  await vi.advanceTimersByTimeAsync(25);
  expect(fixture.sockets).toHaveLength(3);
  expect(fixture.sockets[1]!.terminate).toHaveBeenCalledOnce();
  expect(acquireFileLock).toHaveBeenCalledTimes(3);
  expect(readLocalRuntimeEndpoint).toHaveBeenCalledTimes(3);

  await vi.advanceTimersByTimeAsync(24);
  expect(settled).not.toHaveBeenCalled();
  expect(createOwner).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toHaveBeenCalledOnce();
  await expect(pending).rejects.toThrow("local_runtime_owner_start_timeout");
  expect(fixture.sockets[2]!.terminate).toHaveBeenCalledOnce();
  expect(createOwner).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
