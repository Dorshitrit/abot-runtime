import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { expect, test, vi } from "vitest";
const prepare = vi.hoisted(() => vi.fn(async () => ({
  permissions: { screenRecording: "required", accessibility: "granted" } as const,
  executablePath: "/private/companion/node", restartMayBeRequired: false,
})));
vi.mock("../../computer-access/companion/native-permissions.js", async (load) => {
  const actual = await load<typeof import("../../computer-access/companion/native-permissions.js")>();
  return { ...actual, createNativePermissionHandlers: (platform: string) => actual.createNativePermissionHandlers(platform, prepare) };
});
import { connectNativeHost } from "../../computer-access/companion/native-session.js";
import { MACOS_PERMISSION_CAPABILITY } from "../../computer-access/companion/permission-protocol.js";

test("the Mac companion advertises and executes permission control independently of desktop sessions", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const stop = new AbortController();
  const hostId = randomUUID();
  const operationId = randomUUID();
  const received = new Promise<Record<string, unknown>>((resolve) => {
    server.on("connection", (client) => {
      client.on("message", (bytes) => {
        const message = JSON.parse(bytes.toString());
        if (message.type === "hello") {
          expect(message.capabilities).toContain(MACOS_PERMISSION_CAPABILITY);
          client.send(JSON.stringify({ type: "ready", hostId }));
          client.send(JSON.stringify({ type: "execute", hostId, id: operationId,
            operation: "macos_permissions", params: { target: "macos", action: "check" } }));
          return;
        }
        if (message.type === "result") resolve(message);
      });
    });
  });
  const session = connectNativeHost({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    authorization: "a".repeat(43), hostId, signal: stop.signal,
    identity: { name: "Mac fixture", os: "macos", user: "test", homeDir: "/Users/test" },
    onPaired: async () => { throw new Error("Unexpected pairing"); }, onReady: () => {},
    notifications: { ready: false, handlers: () => ({}), close: () => {} },
  });
  try {
    expect(await received).toMatchObject({ type: "result", id: operationId,
      result: { ok: true, data: { permissions: { screenRecording: "required", accessibility: "granted" } } } });
    expect(prepare).toHaveBeenCalledExactlyOnceWith({ action: "check" }, expect.any(AbortSignal));
  } finally {
    stop.abort();
    await session;
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
