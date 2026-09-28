import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, test, vi } from "vitest";
import type { ToolImplementation } from "../../plugin-sdk/index.js";
import { connectNativeHost } from "../../computer-access/companion/native-session.js";

afterEach(() => vi.useRealTimers());

async function fixture(
  handler: ToolImplementation,
  trackHandshakeTimeout = false,
) {
  vi.useFakeTimers({
    toFake: trackHandshakeTimeout
      ? ["setInterval", "clearInterval", "setTimeout", "clearTimeout"]
      : ["setInterval", "clearInterval"],
  });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP listener");
  const hostId = randomUUID();
  const stop = new AbortController();
  const messages: Array<{
    type: string;
    id?: string;
    result?: { ok: boolean; output: string };
  }> = [];
  const events: string[] = [];
  let releaseReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const readyGate = new Promise<void>((resolve, reject) => {
    releaseReady = resolve;
    rejectReady = reject;
  });
  const onReady = vi.fn(async () => readyGate);
  const notifications = { ready: false, handlers: () => ({}), close: vi.fn() };
  const connected = once(server, "connection") as Promise<[WebSocket]>;
  const running = connectNativeHost({
    url: `http://127.0.0.1:${address.port}`,
    authorization: "a".repeat(43),
    hostId,
    identity: { name: "fixture", os: "linux", user: "qa", homeDir: "/home/qa" },
    signal: stop.signal,
    notifications,
    heartbeatMs: trackHandshakeTimeout ? 60_000 : 100,
    handlers: { system_command: handler },
    onReady,
    onPaired: async () => {
      throw new Error("Unexpected pairing");
    },
  });
  const [socket] = await connected;
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    messages.push(message);
    events.push(
      message.type === "result" ? `result:${message.id}` : message.type,
    );
  });
  socket.on("close", (_code, reason) =>
    events.push(`close:${reason.toString()}`),
  );
  await vi.waitFor(() => expect(messages).toHaveLength(1));
  socket.send(JSON.stringify({ type: "ready", hostId }));
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  return {
    socket,
    messages,
    events,
    running,
    notifications,
    stop,
    releaseReady,
    rejectReady,
    send: (message: Record<string, unknown>) =>
      socket.send(JSON.stringify(message)),
    execute: (command: string) => {
      const id = randomUUID();
      socket.send(
        JSON.stringify({
          type: "execute",
          hostId,
          id,
          operation: "system_command",
          params: { target: "linux", cwd: "/tmp", command },
        }),
      );
      return id;
    },
    async close() {
      releaseReady();
      stop.abort();
      await running;
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test.each([false, true])(
  "capability refresh drains admitted execute/cancel frames after held readiness (cancel=%s)",
  async (cancel) => {
    const handler = vi.fn<ToolImplementation>(async (params, context) => {
      if (cancel && params.command === "first") {
        await new Promise<void>((resolve) =>
          context!.abortSignal!.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return {
          ok: false,
          output: "cancel acknowledged",
          errorCode: "cancelled",
          producedNewInformation: false,
        };
      }
      return {
        ok: true,
        output: String(params.command),
        producedNewInformation: true,
      };
    });
    const f = await fixture(handler);
    try {
      const first = f.execute("first");
      if (cancel) f.send({ type: "cancel", id: first });
      const second = f.execute("second");
      f.notifications.ready = true;
      // A later transport frame is admitted while onReady is still awaiting storage.
      const third = f.execute("third");
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      if (cancel) {
        await vi.advanceTimersByTimeAsync(100);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(f.socket.readyState).toBe(WebSocket.OPEN);
        expect(handler).not.toHaveBeenCalled();
      }
      f.releaseReady();
      await vi.waitFor(() =>
        expect(
          f.messages.filter((message) => message.type === "result"),
        ).toHaveLength(3),
      );
      expect(handler).toHaveBeenCalledTimes(3);
      expect(
        f.messages.find((message) => message.id === first)?.result?.output,
      ).toBe(cancel ? "cancel acknowledged" : "first");
      expect(
        f.messages.find((message) => message.id === second)?.result?.output,
      ).toBe("second");
      expect(
        f.messages.find((message) => message.id === third)?.result?.output,
      ).toBe("third");
      expect(await f.running).toBe("disconnected");
      await vi.waitFor(() =>
        expect(f.events.at(-1)).toBe("close:capabilities_changed"),
      );
      expect(f.events.slice(1, -1).sort()).toEqual(
        [first, second, third].map((id) => `result:${id}`).sort(),
      );
      expect(f.notifications.close).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
    }
  },
);

test("a valid ready frame clears the handshake deadline while local readiness persistence is still pending", async () => {
  const handler = vi.fn<ToolImplementation>(async () => ({
    ok: true,
    output: "queued operation completed",
    producedNewInformation: true,
  }));
  const f = await fixture(handler, true);
  try {
    const id = f.execute("queued");
    f.notifications.ready = true;
    await vi.advanceTimersByTimeAsync(12_001);
    expect(f.socket.readyState).toBe(WebSocket.OPEN);
    expect(handler).not.toHaveBeenCalled();
    f.releaseReady();
    await vi.waitFor(() =>
      expect(
        f.messages.find((message) => message.id === id)?.result,
      ).toMatchObject({ ok: true, output: "queued operation completed" }),
    );
    expect(await f.running).toBe("disconnected");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await f.close();
  }
});

test.each(["protocol", "shutdown", "ready_failure"] as const)(
  "%s while readiness is pending drains admitted work without dispatch or a capability refresh",
  async (failure) => {
    const handler = vi.fn<ToolImplementation>(async () => ({
      ok: true,
      output: "should not run",
      producedNewInformation: false,
    }));
    const f = await fixture(handler);
    try {
      if (failure === "protocol") f.send({ type: "unsupported_control" });
      const id = f.execute("queued");
      f.send({ type: "cancel", id });
      f.notifications.ready = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      if (failure === "shutdown") f.stop.abort();
      if (failure === "ready_failure")
        f.rejectReady(new Error("status write failed"));
      else f.releaseReady();
      expect(await f.running).toBe(
        failure === "shutdown" ? "stopped" : "protocol_rejected",
      );
      expect(handler).not.toHaveBeenCalled();
      expect(f.messages.filter((message) => message.type === "result")).toEqual(
        [],
      );
      expect(f.events).not.toContain("close:capabilities_changed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
    }
  },
);
