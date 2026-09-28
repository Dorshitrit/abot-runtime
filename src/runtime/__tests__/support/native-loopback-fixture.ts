import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer, type ServerOptions } from "node:https";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";
import { vi } from "vitest";
import {
  connectNativeHost,
  type NativeSessionOptions,
} from "../../../computer-access/companion/native-session.js";

export async function nativeLoopbackFixture(
  address: "127.0.0.1" | "::1",
  hostname = "localhost",
  tls?: ServerOptions,
) {
  const http = tls ? createHttpsServer(tls) : createHttpServer();
  const server = new WebSocketServer({ server: http });
  const sockets = new Set<Socket>();
  const requests: IncomingMessage[] = [];
  const messages: unknown[] = [];
  const hostId = randomUUID();
  const credential = "a".repeat(43);
  const stop = new AbortController();
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connection", (client, request) => {
    requests.push(request);
    client.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
      client.send(JSON.stringify({ type: "paired", hostId, credential }));
    });
  });
  http.listen({ host: address, port: 0, ipv6Only: true });
  await once(http, "listening");
  const listener = http.address();
  if (!listener || typeof listener === "string")
    throw new Error("Expected TCP test listener.");
  const url = `${tls ? "https" : "http"}://${hostname}:${listener.port}`;
  const onPaired = vi.fn(async (_hostId: string, _credential: string) => {
    for (const client of server.clients) client.close(1000);
  });
  const onReady = vi.fn();
  const connect = (options: Partial<NativeSessionOptions> = {}) => connectNativeHost({
    url,
    authorization: credential,
    identity: { name: "Loopback fixture", os: "macos", user: "test", homeDir: "/Users/test" },
    signal: stop.signal,
    handlers: {},
    notifications: { ready: false, handlers: () => ({}), close: () => {} },
    onPaired,
    onReady,
    ...options,
  });
  const close = async () => {
    stop.abort();
    for (const client of server.clients) client.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  return { http, server, requests, messages, hostId, credential, stop, url,
    port: listener.port, onPaired, onReady, connect, close };
}
