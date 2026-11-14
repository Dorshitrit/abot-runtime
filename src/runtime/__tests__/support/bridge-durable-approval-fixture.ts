import { once } from "node:events";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { ToolModuleDeclaration } from "../../../capabilities/tool-types.js";
import { successResult } from "../../../plugin-sdk/index.js";
import {
  startAgentBridge,
  type AgentBridgeHandle,
} from "../../../bridge/start-agent-bridge.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { createLocalRuntimeApplication } from "../../local-application.js";
import { createLocalRuntimeOwner } from "../../local-host/app-owner.js";
import { resolveLocalRuntimeIdentity } from "../../local-host/client-identity.js";
import type {
  LocalRuntimeConnection,
  LocalRuntimeOwner,
} from "../../local-host/contracts.js";
import { createLocalRuntimeConnection } from "../../local-host/transport.js";
import { createBridgeApprovalScript } from "./bridge-approval-script.js";
import { createSchedulerRuntimeFixture } from "./scheduler-runtime-fixture.js";

export type BridgeApprovalFrame = Record<string, unknown>;

/** Real local owner and Bridge transport; model decisions and effects are scripted. */
export async function createBridgeApprovalFixture(options: {
  legacyHandler?: boolean;
  grouped?: boolean;
} = {}) {
  const base = await createSchedulerRuntimeFixture("execution-agent-v1");
  await base.application.stop();
  const model = createBridgeApprovalScript(options.grouped === true);
  const execute = vi.fn(async () =>
    successResult({ output: "The approved fixture effect completed." }),
  );
  const module: ToolModuleDeclaration = {
    definition: {
      name: "bridge_fixture_effect",
      routingCapability: "semantic_mutation",
      catalogGroups: ["bridge_fixture"],
    },
    normalInvocation: {
      version: 1,
      operations: (options.grouped
        ? ["record_bridge_effect", "record_second_bridge_effect"]
        : ["record_bridge_effect"]).map((operationId) => ({
        operationId,
        ...(options.grouped ? { fixedParams: { action: operationId } } : {}),
        summary: "Record a fixture effect.",
        effect: options.grouped ? "read_only" : "mutating",
        approval: options.grouped ? "always" : "request_policy",
        input: { type: "object", additionalProperties: false, properties: {}, required: [] },
      })),
    },
    implementation: execute,
  };
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const frames: BridgeApprovalFrame[] = [];
  let socket: WebSocket | undefined;
  let bridge: AgentBridgeHandle | undefined;
  let client: ReturnType<typeof createLocalRuntimeApplication> | undefined;
  let localRpcSocket: WebSocket | undefined;
  let connection: LocalRuntimeConnection | undefined;
  let owner: LocalRuntimeOwner | undefined;
  let correlationSequence = 0;
  let discardedReply: { correlationId: string; received: boolean } | undefined;
  server.on("connection", (connected) => {
    socket = connected;
    connected.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as BridgeApprovalFrame;
      if (frame.correlationId === discardedReply?.correlationId && discardedReply) {
        discardedReply.received = true;
        return;
      }
      frames.push(frame);
      if (frame.type === "register")
        connected.send(JSON.stringify({ type: "registered", ok: true, agentId: base.config.runtimeId }));
    });
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_listener_missing");
  const url = `ws://127.0.0.1:${address.port}`;

  async function startOwner() {
    owner = await createLocalRuntimeOwner(base.config, {
      models: model,
      tools: createConfiguredToolRegistry(base.config, [module]),
    });
    const currentOwner = owner;
    connection = await createLocalRuntimeConnection({
      directory: join(base.config.paths.runtimeDir, "local-host"),
      identity: resolveLocalRuntimeIdentity(base.config),
      createOwner: async () => currentOwner,
    });
  }

  async function startBridge() {
    client = createLocalRuntimeApplication(base.config);
    const handleUpgrade = WebSocketServer.prototype.handleUpgrade;
    const capture = vi.spyOn(WebSocketServer.prototype, "handleUpgrade").mockImplementation(
      function (this: WebSocketServer, request, socket, head, callback) {
        return handleUpgrade.call(this, request, socket, head, (connected, upgradedRequest) => {
          if (this !== server) localRpcSocket = connected;
          callback(connected, upgradedRequest);
        });
      },
    );
    try {
      await client.start();
    } finally {
      capture.mockRestore();
    }
    const requestHandler = options.legacyHandler
      ? { handle: client.requests.handle, steer: client.requests.steer, cancel: client.requests.cancel }
      : client.requests;
    bridge = startAgentBridge({
      url,
      token: "fixture-only-token",
      runtimeConfig: base.config,
      runtimeId: base.config.runtimeId,
      sessionStore: client.services.sessions,
      requestHandler,
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
      reconnectJitterRatio: 0,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 120_000,
      statusLogIntervalMs: 0,
    });
    await vi.waitFor(() => expect(bridge?.getStatus().registered).toBe(true), { timeout: 5000 });
  }

  async function stopBridge() {
    await bridge?.stop();
    bridge = undefined;
    await client?.stop();
    client = undefined;
  }

  async function restart(restartOwner = false) {
    await stopBridge();
    if (restartOwner) {
      await connection?.close();
      await owner?.whenIdle?.();
      connection = undefined;
      await startOwner();
    }
    await startBridge();
  }

  async function waitForFrame(
    predicate: (frame: BridgeApprovalFrame) => boolean,
    after = 0,
  ): Promise<BridgeApprovalFrame> {
    let found: BridgeApprovalFrame | undefined;
    await vi.waitFor(() => {
      found = frames.slice(after).find(predicate);
      expect(found, "expected Bridge response/event").toBeDefined();
    }, { timeout: 5000, interval: 10 });
    return found!;
  }

  function send(frame: BridgeApprovalFrame) {
    if (!socket) throw new Error("fixture_bridge_not_connected");
    socket.send(JSON.stringify(frame));
  }

  async function command(frame: BridgeApprovalFrame) {
    const correlationId = `fixture-command-${++correlationSequence}`;
    const after = frames.length;
    send({ ...frame, correlationId });
    return waitForFrame((response) => response.correlationId === correlationId, after);
  }

  async function replaceRemoteSocket() {
    const after = frames.length;
    socket?.close(1011, "fixture remote reconnect");
    await waitForFrame((frame) => frame.type === "register", after);
    await vi.waitFor(() => expect(bridge?.getStatus().registered).toBe(true));
  }

  async function sendLosingReply(frame: BridgeApprovalFrame) {
    const correlationId = `discarded-command-${++correlationSequence}`;
    discardedReply = { correlationId, received: false };
    send({ ...frame, correlationId });
    await vi.waitFor(() => expect(discardedReply?.received).toBe(true), { timeout: 5000 });
    return correlationId;
  }

  async function disconnectLocalRpc() {
    if (!localRpcSocket) throw new Error("fixture_local_rpc_socket_missing");
    const closed = once(localRpcSocket, "close");
    localRpcSocket.terminate();
    await closed;
    await vi.waitFor(async () => {
      await expect(client!.services.sessions.getSessionById("session")).rejects.toThrow();
    });
  }

  async function dispose() {
    await stopBridge();
    await connection?.close();
    await owner?.whenIdle?.();
    for (const connected of server.clients) connected.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await base.dispose();
  }

  try {
    await startOwner();
    await startBridge();
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    base, model, execute, frames, send, command, waitForFrame, restart, replaceRemoteSocket, dispose,
    sendLosingReply, disconnectLocalRpc,
    get owner() { return owner!; },
  };
}
