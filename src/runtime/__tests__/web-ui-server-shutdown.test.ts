import { once } from "node:events";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { startWebUiServer } from "../../web-ui/server.js";

const mock = vi.hoisted(() => ({
  server: undefined as Server | undefined,
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  realtime: vi.fn(),
}));
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      mock.server = actual.createServer(...args);
      return mock.server;
    },
  };
});
vi.mock("../../web-ui/local-runtime-backend.js", () => ({
  LocalRuntimeWebBackend: class {
    start = mock.start;
    stop = mock.stop;
    handleRealtimeConnection = mock.realtime;
  },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  mock.start.mockReset().mockResolvedValue(undefined);
  mock.stop.mockReset().mockResolvedValue(undefined);
  mock.realtime.mockClear();
});

test.each(["startup", "environment stop"])(
  "close rejects new HTTP and WebSocket intake while %s is pending",
  async (phase) => {
    const gate = deferred();
    if (phase === "startup") mock.start.mockReturnValueOnce(gate.promise);
    else mock.stop.mockReturnValueOnce(gate.promise);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const handle = startWebUiServer({
      host: "127.0.0.1",
      port: 0,
      backend: "runtime",
      rootDir: tmpdir(),
    });
    const server = mock.server!;
    if (!server.listening) await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/web-realtime`);
    await once(socket, "open");
    const closedSocket = once(socket, "close");
    const closing = handle.close();
    try {
      expect(server.listening).toBe(false);
      expect(mock.stop).toHaveBeenCalledTimes(1);
      await expect(
        fetch(`http://127.0.0.1:${port}/web-config`),
      ).rejects.toThrow();
      await closedSocket;
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      socket.terminate();
      gate.resolve();
      await closing;
    }
  },
);

test("repeated close shares shutdown and still stops the backend after startup failure", async () => {
  const failure = new Error("startup_failed");
  mock.start.mockRejectedValueOnce(failure);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const handle = startWebUiServer({
    host: "127.0.0.1",
    port: 0,
    backend: "runtime",
    rootDir: tmpdir(),
  });
  const first = handle.close();
  const second = handle.close();
  const outcomes = await Promise.allSettled([first, second]);
  expect(first).toBe(second);
  expect(outcomes).toEqual([
    { status: "rejected", reason: failure },
    { status: "rejected", reason: failure },
  ]);
  expect(mock.stop).toHaveBeenCalledTimes(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mock.server!.listening).toBe(false);
});

test("startup failure retains precedence while backend shutdown also fails", async () => {
  let rejectStartup!: (error: Error) => void;
  const startup = new Promise<void>((_resolve, reject) => {
    rejectStartup = reject;
  });
  mock.start.mockReturnValueOnce(startup);
  mock.stop.mockRejectedValueOnce(new Error("backend_stop_failed"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  const handle = startWebUiServer({
    host: "127.0.0.1",
    port: 0,
    backend: "runtime",
    rootDir: tmpdir(),
  });
  const closing = handle.close();
  const failure = new Error("startup_failed");
  rejectStartup(failure);
  await expect(closing).rejects.toBe(failure);
  expect(mock.stop).toHaveBeenCalledTimes(1);
});

test("bridge transport closes without acquiring or stopping local environments", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const handle = startWebUiServer({
    host: "127.0.0.1",
    port: 0,
    backend: "bridge",
    rootDir: tmpdir(),
  });
  if (!mock.server!.listening) await once(mock.server!, "listening");
  await handle.close();
  expect(mock.server!.listening).toBe(false);
  expect(mock.start).not.toHaveBeenCalled();
  expect(mock.stop).not.toHaveBeenCalled();
});
