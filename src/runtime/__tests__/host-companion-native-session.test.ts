import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { expect, test, vi } from "vitest";
import type { ToolImplementation } from "../../plugin-sdk/index.js";
import { connectNativeHost } from "../../computer-access/companion/native-session.js";
import type { HostIdentity } from "../../computer-access/companion/protocol.js";
import { COMPANION_RELEASE_VERSION } from "../../computer-access/companion/release-version.js";

const identity: HostIdentity = {
  name: "Native test",
  os: "windows",
  user: "test",
  homeDir: "C:\\Users\\test",
};
const credential = "a".repeat(43);
const success = {
  ok: true,
  output: "native result",
  producedNewInformation: true,
};

async function fixture(
  run: (context: {
    server: WebSocketServer;
    url: string;
    hostId: string;
    stop: AbortController;
  }) => Promise<void>,
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP test listener.");
  const stop = new AbortController();
  try {
    await run({
      server,
      url: `http://abot-native.localhost:${address.port}`,
      hostId: randomUUID(),
      stop,
    });
  } finally {
    stop.abort();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function startSession(
  context: { url: string; hostId: string; stop: AbortController },
  handlers: Record<string, ToolImplementation>,
) {
  return connectNativeHost({
    url: context.url,
    hostId: context.hostId,
    authorization: credential,
    identity,
    signal: context.stop.signal,
    handlers,
    onPaired: async () => {
      throw new Error("Unexpected pairing");
    },
    onReady: () => {},
  });
}

function ready(client: WebSocket, hostId: string, operation: unknown) {
  client.once("message", () => {
    client.send(JSON.stringify({ type: "ready", hostId }));
    client.send(JSON.stringify(operation));
  });
}

test("persists pairing before a graceful socket close settles and sends credentials only in the handshake header", async () => {
  await fixture(async ({ server, url, hostId, stop }) => {
    const order: string[] = [];
    server.once("connection", (client, request) => {
      expect(request.headers.authorization).toBe(`Bearer ${credential}`);
      expect(request.headers.origin).toBeUndefined();
      expect(request.url).toBe("/system-host/connect");
      client.once("message", (bytes) => {
        expect(JSON.parse(bytes.toString())).toEqual({
          type: "hello",
          version: 1,
          identity,
          capabilities: ["passive-observations-v1", "computer_control_v1"],
          companionVersion: COMPANION_RELEASE_VERSION,
        });
        client.send(JSON.stringify({ type: "paired", hostId, credential }));
        client.close(1000, "reconnect_with_credential");
      });
    });
    const result = await connectNativeHost({
      url,
      authorization: credential,
      identity,
      signal: stop.signal,
      onPaired: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        order.push("persisted");
      },
      onReady: () => {
        throw new Error("Pairing does not activate a connection");
      },
    });
    expect(result).toBe("disconnected");
    expect(order).toEqual(["persisted"]);
  });
});

test("executes only the bound host operation and returns its matching result", async () => {
  await fixture(async (context) => {
    const id = randomUUID();
    const handler = vi.fn<ToolImplementation>(async () => success);
    const resultReceived = new Promise<unknown>((resolve) => {
      context.server.once("connection", (client) => {
        ready(client, context.hostId, {
          type: "execute",
          id,
          hostId: context.hostId,
          operation: "system_command",
          params: {
            target: "windows",
            cwd: "C:\\",
            command: "unused injected command",
          },
        });
        client.on("message", (bytes) => {
          const message = JSON.parse(bytes.toString());
          if (message.type === "result") resolve(message);
        });
      });
    });
    const pending = startSession(context, { system_command: handler });
    expect(await resultReceived).toEqual({
      type: "result",
      id,
      result: success,
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![1]?.abortSignal).toBeInstanceOf(AbortSignal);
    context.stop.abort();
    expect(await pending).toBe("stopped");
  });
});

test.each(["wrong-host", "unknown-operation"])(
  "rejects %s before native execution",
  async (fault) => {
    await fixture(async (context) => {
      const handler = vi.fn<ToolImplementation>(async () => success);
      context.server.once("connection", (client) =>
        ready(client, context.hostId, {
          type: "execute",
          id: randomUUID(),
          hostId: fault === "wrong-host" ? randomUUID() : context.hostId,
          operation:
            fault === "unknown-operation" ? "arbitrary_tool" : "system_command",
          params: { target: "windows", cwd: "C:\\", command: "unused" },
        }),
      );
      expect(await startSession(context, { system_command: handler })).toBe(
        "protocol_rejected",
      );
      expect(handler).not.toHaveBeenCalled();
    });
  },
);

test("a wrong native target fails one operation and preserves the next correct operation", async () => {
  await fixture(async (context) => {
    const badId = randomUUID();
    const goodId = randomUUID();
    const handler = vi.fn<ToolImplementation>(async () => success);
    const received: any[] = [];
    const completed = new Promise<void>((resolve) => {
      context.server.once("connection", (client) => {
        ready(client, context.hostId, {
          type: "execute",
          id: badId,
          hostId: context.hostId,
          operation: "system_command",
          params: { target: "linux", cwd: "/tmp", command: "unused" },
        });
        client.on("message", (bytes) => {
          const message = JSON.parse(bytes.toString());
          if (message.type !== "result") return;
          received.push(message);
          if (message.id === badId) {
            client.send(
              JSON.stringify({
                type: "execute",
                id: goodId,
                hostId: context.hostId,
                operation: "system_command",
                params: { target: "windows", cwd: "C:\\", command: "unused" },
              }),
            );
            return;
          }
          resolve();
        });
      });
    });
    const pending = startSession(context, { system_command: handler });
    await completed;
    expect(received[0].result.errorCode).toBe("system_target_unavailable");
    expect(received[1].result).toEqual(success);
    expect(handler).toHaveBeenCalledOnce();
    context.stop.abort();
    await pending;
  });
});

test.each(["cancel", "disconnect", "duplicate"])(
  "%s aborts an active native operation without replay",
  async (action) => {
    await fixture(async (context) => {
      const id = randomUUID();
      let client: WebSocket;
      let observeStart!: () => void;
      const started = new Promise<void>((resolve) => {
        observeStart = resolve;
      });
      const aborted = vi.fn();
      const operation = {
        type: "execute",
        id,
        hostId: context.hostId,
        operation: "system_command",
        params: { target: "windows", cwd: "C:\\", command: "unused" },
      };
      const handler = vi.fn<ToolImplementation>(
        async (_params, execution) =>
          new Promise((resolve) => {
            execution!.abortSignal!.addEventListener(
              "abort",
              () => {
                aborted();
                resolve(success);
              },
              { once: true },
            );
            observeStart();
          }),
      );
      context.server.once("connection", (socket) => {
        client = socket;
        ready(socket, context.hostId, operation);
      });
      const pending = startSession(context, { system_command: handler });
      await started;
      if (action === "cancel")
        client!.send(JSON.stringify({ type: "cancel", id }));
      if (action === "disconnect") client!.terminate();
      if (action === "duplicate") client!.send(JSON.stringify(operation));
      await vi.waitFor(() => expect(aborted).toHaveBeenCalledOnce());
      expect(handler).toHaveBeenCalledOnce();
      context.stop.abort();
      await pending;
    });
  },
);

test("refuses an HTTP redirect rather than forwarding the host credential", async () => {
  await fixture(async (context) => {
    context.server.on("headers", () => {});
    // A rejected HTTP upgrade is handled without following a Location header.
    const rejecting = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: (_info, done) =>
        done(false, 302, "Moved", { Location: "ws://192.0.2.1:9999" }),
    });
    await once(rejecting, "listening");
    const address = rejecting.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP listener");
    try {
      expect(
        await startSession(
          { ...context, url: `http://127.0.0.1:${address.port}` },
          {},
        ),
      ).toBe("protocol_rejected");
    } finally {
      await new Promise<void>((resolve) => rejecting.close(() => resolve()));
    }
  });
});
