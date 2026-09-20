import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { expect, test, vi } from "vitest";
import { connectNativeHost } from "../../../plugins/system/source/companion/native-session.js";

async function fixture(autoPong = true) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected listener address");
  const signal = new AbortController();
  const hostId = randomUUID();
  return {
    server,
    hostId,
    signal,
    options: {
      url: `http://127.0.0.1:${address.port}`,
      authorization: "a".repeat(43),
      hostId,
      identity: {
        name: "test",
        os: "windows" as const,
        user: "test",
        homeDir: "C:\\Users\\test",
      },
      signal: signal.signal,
      onPaired: async () => {
        throw new Error("Unexpected pairing");
      },
      onReady: () => {},
    },
    async close() {
      signal.abort();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("missing pong ends the connection and aborts its active work", async () => {
  const context = await fixture(false);
  const aborted = vi.fn();
  const invoked = vi.fn();
  try {
    context.server.once("connection", (client) =>
      client.once("message", () => {
        client.send(JSON.stringify({ type: "ready", hostId: context.hostId }));
        client.send(
          JSON.stringify({
            type: "execute",
            id: randomUUID(),
            hostId: context.hostId,
            operation: "system_command",
            params: { target: "windows", cwd: "C:\\", command: "unused" },
          }),
        );
      }),
    );
    const result = await connectNativeHost({
      ...context.options,
      heartbeatMs: 25,
      handlers: {
        system_command: async (_params, execution) =>
          new Promise((resolve) => {
            invoked();
            execution!.abortSignal!.addEventListener(
              "abort",
              () => {
                aborted();
                resolve({
                  ok: false,
                  output: "aborted",
                  producedNewInformation: false,
                });
              },
              { once: true },
            );
          }),
      },
    });
    expect(result).toBe("disconnected");
    expect(invoked).toHaveBeenCalledOnce();
    expect(aborted).toHaveBeenCalledOnce();
  } finally {
    await context.close();
  }
});

test.each([
  { code: 1001, reason: "runtime_stopped", expected: "disconnected" },
  { code: 1008, reason: "host_revoked", expected: "authorization_rejected" },
  {
    code: 1008,
    reason: "host_protocol_rejected",
    expected: "protocol_rejected",
  },
])(
  "classifies close $reason without confusing restart with revocation",
  async ({ code, reason, expected }) => {
    const context = await fixture();
    try {
      context.server.once("connection", (client) =>
        client.once("message", () => {
          client.send(
            JSON.stringify({ type: "ready", hostId: context.hostId }),
          );
          client.close(code, reason);
        }),
      );
      expect(await connectNativeHost(context.options)).toBe(expected);
    } finally {
      await context.close();
    }
  },
);

test("bounds an oversized native result without repeating its operation", async () => {
  const context = await fixture();
  const handler = vi.fn(async () => ({
    ok: true,
    output: "x".repeat(300_000),
    producedNewInformation: true,
  }));
  try {
    const result = new Promise<unknown>((resolve) =>
      context.server.once("connection", (client) => {
        client.once("message", () => {
          client.send(
            JSON.stringify({ type: "ready", hostId: context.hostId }),
          );
          client.send(
            JSON.stringify({
              type: "execute",
              id: randomUUID(),
              hostId: context.hostId,
              operation: "system_command",
              params: { target: "windows", cwd: "C:\\", command: "unused" },
            }),
          );
        });
        client.on("message", (bytes) => {
          const value = JSON.parse(bytes.toString());
          if (value.type === "result") resolve(value.result);
        });
      }),
    );
    const connection = connectNativeHost({
      ...context.options,
      handlers: { system_command: handler },
    });
    expect(await result).toMatchObject({
      ok: false,
      errorCode: "system_host_result_too_large",
    });
    context.signal.abort();
    await connection;
    expect(handler).toHaveBeenCalledOnce();
  } finally {
    await context.close();
  }
});

test("connection operation limit returns a non-dispatch receipt and reconnectable outcome", async () => {
  const context = await fixture();
  const handler = vi.fn(async () => ({
    ok: true,
    output: "observed",
    producedNewInformation: true,
  }));
  try {
    const receipts: Array<{ id: string; result: { errorCode?: string } }> = [];
    const first = randomUUID();
    const overLimit = randomUUID();
    context.server.once("connection", (client) => {
      const execute = (id: string) =>
        client.send(
          JSON.stringify({
            type: "execute",
            id,
            hostId: context.hostId,
            operation: "system_targets",
            params: {},
          }),
        );
      client.once("message", () => {
        client.send(JSON.stringify({ type: "ready", hostId: context.hostId }));
        execute(first);
      });
      client.on("message", (bytes) => {
        const message = JSON.parse(bytes.toString());
        if (message.type !== "result") return;
        receipts.push(message);
        if (message.id === first) execute(overLimit);
      });
    });
    expect(
      await connectNativeHost({
        ...context.options,
        operationLimit: 1,
        handlers: { system_targets: handler },
      }),
    ).toBe("disconnected");
    expect(receipts.map(({ id }) => id)).toEqual([first, overLimit]);
    expect(receipts[1]!.result.errorCode).toBe(
      "system_host_connection_refresh",
    );
    expect(handler).toHaveBeenCalledOnce();
  } finally {
    await context.close();
  }
});
