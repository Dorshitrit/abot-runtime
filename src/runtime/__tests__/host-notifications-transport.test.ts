import { runNativeHostSupervisor } from "../../computer-access/companion/native-supervisor.js";
import type { NativeHostState } from "../../computer-access/companion/native-state.js";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import { connectNativeHost } from "../../computer-access/companion/native-session.js";
import { createNotificationSession } from "../../computer-access/companion/native-notifications.js";
import { DESKTOP_NOTIFICATION_CAPABILITY } from "../../computer-access/companion/notification-protocol.js";

test("authenticated native connection advertises ready notification support and submits a bound source once", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected listener");
  const origin = "http://127.0.0.1:" + address.port;
  const hostId = randomUUID(),
    id = randomUUID();
  const signal = new AbortController();
  const renderer = {
    send: vi.fn(async (_notification: unknown, _signal?: AbortSignal) => {}),
    close: vi.fn(),
  };
  const payload = {
    target: "linux",
    notificationId: "e".repeat(64),
    title: "ABot needs attention",
    body: "Review a request",
    url: "/chat?environment=dev&session=s1",
  };
  const received = new Promise<any>((resolve, reject) => {
    server.once("connection", (socket, request) => {
      expect(request.headers.authorization).toBe("Bearer " + "a".repeat(43));
      socket.on("message", (bytes) => {
        try {
          const message = JSON.parse(bytes.toString());
          if (message.type === "result") {
            resolve(message);
            return;
          }
          expect(message.capabilities).toContain(
            DESKTOP_NOTIFICATION_CAPABILITY,
          );
          socket.send(JSON.stringify({ type: "ready", hostId }));
          socket.send(
            JSON.stringify({
              type: "execute",
              hostId,
              id,
              operation: "desktop_notification",
              params: payload,
            }),
          );
        } catch (error) {
          reject(error);
        }
      });
    });
  });
  const pending = connectNativeHost({
    url: origin,
    hostId,
    authorization: "a".repeat(43),
    identity: { os: "linux", name: "QA", user: "qa", homeDir: "/home/qa" },
    signal: signal.signal,
    onPaired: async () => {
      throw new Error("Already paired");
    },
    onReady: () => {},
    notifications: createNotificationSession("linux", origin, true, renderer),
  });
  try {
    expect(await received).toMatchObject({
      type: "result",
      id,
      result: {
        ok: true,
        data: { notificationId: payload.notificationId, delivery: "submitted" },
      },
    });
    expect(renderer.send).toHaveBeenCalledOnce();
    expect(renderer.send.mock.calls[0]?.[0]).toEqual({
      ...payload,
      url: origin + payload.url,
    });
  } finally {
    signal.abort();
    await pending;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect(renderer.close).not.toHaveBeenCalled();
});

test("supervisor preserves submitted notification handlers across reconnect and closes once on shutdown", async () => {
  const saved = {
    version: 1 as const,
    url: "ws://localhost:5199",
    hostId: randomUUID(),
    credential: "a".repeat(43),
  };
  const stop = new AbortController();
  const notifications = { ready: true, handlers: () => ({}), close: vi.fn() };
  const state: NativeHostState = {
    directory: "/fixture/state",
    read: async () => saved,
    write: async () => {},
    remove: async () => {},
    setStatus: async () => {},
    isConnected: async () => false,
  };
  let attempts = 0;
  await runNativeHostSupervisor({
    state,
    notifications,
    signal: stop.signal,
    reconnectDelayMs: 1,
    identity: { os: "linux", name: "QA", user: "qa", homeDir: "/home/qa" },
    connect: async (options) => {
      expect(options.notifications).toBe(notifications);
      expect(notifications.close).not.toHaveBeenCalled();
      attempts++;
      if (attempts === 1) return "disconnected";
      stop.abort();
      return "stopped";
    },
  });
  expect(attempts).toBe(2);
  expect(notifications.close).toHaveBeenCalledOnce();
});
