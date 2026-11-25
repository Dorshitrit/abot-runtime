import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

const mocks = vi.hoisted(() => ({ traceDebug: vi.fn() }));

vi.mock("../observability/debug-logger.js", () => ({
  traceDebug: mocks.traceDebug,
}));
vi.mock("../../shared/load-dotenv.js", () => ({
  loadDotEnvFile: vi.fn(),
}));

import {
  startAgentBridge,
  type AgentBridgeHandle,
} from "../../bridge/start-agent-bridge.js";

describe("agent bridge registration backoff", () => {
  let server: WebSocketServer | undefined;
  let bridge: AgentBridgeHandle | undefined;

  afterEach(async () => {
    await bridge?.stop();
    bridge = undefined;
    if (server) {
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
      server = undefined;
    }
    vi.clearAllMocks();
  });

  async function listen(): Promise<string> {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a local bridge test address");
    }
    return `ws://127.0.0.1:${address.port}`;
  }

  function reconnectDelays(): number[] {
    return mocks.traceDebug.mock.calls
      .filter(([, event]) => event === "reconnect.scheduled")
      .map(([, , details]) => details.delayMs as number);
  }

  test("backs off across rejected registrations and resets only after acknowledgement", async () => {
    const url = await listen();
    let registrations = 0;
    let admittedPeer: WebSocket | undefined;
    server!.on("connection", (peer) => {
      peer.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "register") return;
        registrations += 1;
        if (registrations <= 4) {
          peer.close(1008, "Runtime unavailable");
          return;
        }
        admittedPeer = peer;
      });
    });

    bridge = startAgentBridge({
      url,
      token: "test-bridge-token",
      runtimeId: "test-runtime",
      requestHandler: { handle: vi.fn(async () => {}) },
      reconnectBaseMs: 20,
      reconnectMaxMs: 80,
      reconnectJitterRatio: 0,
      heartbeatIntervalMs: 10_000,
      statusLogIntervalMs: 0,
      lifecycleTraceEnabled: false,
    });

    await vi.waitFor(() => expect(registrations).toBe(5));
    expect(bridge.getStatus()).toMatchObject({
      state: "open",
      registered: false,
      reconnectAttempt: 4,
    });
    expect(reconnectDelays()).toEqual([20, 40, 80, 80]);

    admittedPeer!.send(
      JSON.stringify({ type: "registered", agentId: "test-runtime", ok: true }),
    );
    await vi.waitFor(() => {
      expect(bridge!.getStatus()).toMatchObject({
        registered: true,
        reconnectAttempt: 0,
      });
    });

    admittedPeer!.close(1011, "Server restarting");
    await vi.waitFor(() => {
      expect(reconnectDelays()).toEqual([20, 40, 80, 80, 20]);
    });
  });

  test("registers an imported case-sensitive ID and classifies rejected registration before admission", async () => {
    const url = await listen();
    const registrations: string[] = [];
    server!.on("connection", peer => peer.once("message", raw => {
      const id = JSON.parse(raw.toString()).agentId;
      registrations.push(id);
      peer.send(JSON.stringify({ type: "registered", ok: true, agentId: registrations.length === 1 ? id.toLowerCase() : id }));
    }));
    bridge = startAgentBridge({ url, token: "fixture", runtimeId: "prod", registrationRuntimeId: "MacStudio",
      requestHandler: { handle: vi.fn(async () => {}) }, reconnectBaseMs: 200, reconnectMaxMs: 200, reconnectJitterRatio: 0 });
    await vi.waitFor(() => expect(bridge!.getStatus()).toMatchObject({ registered: false, connectionError: "socket_connection_rejected" }));
    await vi.waitFor(() => expect(bridge!.getStatus().registered).toBe(true));
    expect(bridge.getStatus().connectionError).toBeUndefined();
    expect(registrations).toEqual(["MacStudio", "MacStudio"]);
  });

  test("stopping during backoff cancels the pending connection attempt", async () => {
    const url = await listen();
    let connections = 0;
    server!.on("connection", (peer) => {
      connections += 1;
      peer.close(1008, "Runtime unavailable");
    });
    bridge = startAgentBridge({
      url,
      token: "test-bridge-token",
      runtimeId: "test-runtime",
      requestHandler: { handle: vi.fn(async () => {}) },
      reconnectBaseMs: 250,
      reconnectMaxMs: 250,
      reconnectJitterRatio: 0,
      heartbeatIntervalMs: 10_000,
      statusLogIntervalMs: 0,
      lifecycleTraceEnabled: false,
    });

    await vi.waitFor(() => expect(reconnectDelays()).toEqual([250]));
    await bridge.stop();
    expect(bridge.getStatus()).toMatchObject({
      state: "stopped",
      nextReconnectAt: undefined,
    });
    await delay(300);
    expect(connections).toBe(1);
    expect(reconnectDelays()).toEqual([250]);
  });
});
