import { afterEach, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import { startAgentBridge, type AgentBridgeHandle } from "../../bridge/start-agent-bridge.js";
import type { SessionStore } from "../ports.js";
import type WebSocket from "ws";
import { publishRequestAdmissionFailure } from "../../bridge/request-admission-failure.js";
import { RuntimeCommandInputError } from "../commands/catalog.js";

let server: WebSocketServer | undefined;
let handle: AgentBridgeHandle | undefined;
afterEach(async () => {
  await handle?.stop(); handle = undefined;
  for (const client of server?.clients ?? []) client.terminate();
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  server = undefined;
});

test.each([new Error("session_busy"), new RuntimeCommandInputError("command_mode_not_supported")])("a rejected command retains its event-only identity: %s", (error) => {
  const send = vi.fn();
  const command = { name: "compact", mode: "run" };
  publishRequestAdmissionFailure({ send } as unknown as WebSocket, {
    type: "run_request", requestId: "command", sessionId: "session", command,
  }, error);
  expect(JSON.parse(send.mock.calls[0]![0])).toEqual({
    type: "failed", requestId: "command", sessionId: "session", requestKind: "command",
    command, name: "command.failed", error: error.message,
  });
});

test.each(["session_busy", "session_awaiting_approval"])("a rejected Bridge request receives a correlated %s terminal frame", async (error) => {
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("missing listener");
  const frames: Record<string, unknown>[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type === "register") {
        socket.send(JSON.stringify({ type: "registered", ok: true }));
        socket.send(JSON.stringify({ type: "run_request", requestId: "rejected", sessionId: "same", text: "Follow up" }));
        return;
      }
      frames.push(message);
    });
  });
  const run = vi.fn(async () => { throw new Error(error); });
  handle = startAgentBridge({
    url: `ws://127.0.0.1:${address.port}`, token: "test-token",
    requestHandler: { handle: run },
    sessionStore: { assertInteractiveSession: async () => {} } as unknown as SessionStore,
  });
  await vi.waitFor(() => expect(frames).toContainEqual({
    type: "failed", requestId: "rejected", sessionId: "same", error,
  }));
  expect(run).toHaveBeenCalledOnce();
});
