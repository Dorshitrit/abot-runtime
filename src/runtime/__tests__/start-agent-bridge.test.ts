import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";

const mocks = vi.hoisted(() => ({
  traceDebug: vi.fn(),
  handleRunRequest: vi.fn(),
}));

vi.mock("../observability/debug-logger.js", () => ({
  traceDebug: mocks.traceDebug,
}));

vi.mock("../request/handler.js", () => ({
  handleRunRequest: mocks.handleRunRequest,
}));

import {
  startAgentBridge,
  type AgentBridgeHandle,
} from "../../bridge/start-agent-bridge.js";
import type { RuntimeConfig } from "../ports.js";
import { REQUEST_INVOKED_STEP_IDS } from "../config/runner/contracts.js";

function createRuntimeConfig(requestRunnerConfigPath: string): RuntimeConfig {
  return {
    runtimeId: "dev",
    agentBridgeUrl: "ws://127.0.0.1",
    modelGatewayUrl: "http://127.0.0.1:11435",
    paths: {
      rootDir: "/tmp/runtime",
      runtimeDir: "/tmp/runtime/.runtime/dev",
      sessionsDir: "/tmp/runtime/.runtime/dev/sessions",
      attachmentsDir: "/tmp/runtime/.runtime/dev/attachments",
      agentWorkDir: "/tmp/runtime/.runtime/dev/sandbox",
      workspaceDir: "/tmp/runtime/workspace",
      sharedDir: "/tmp/runtime/.runtime/shared",
      compiledDir: "/tmp/runtime/.runtime/compiled",
      traceFile: "/tmp/runtime/.runtime/dev/logs/runtime.jsonl",
    },
    models: {
      providers: {
        openai: {
          type: "openai",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      },
      profiles: {
        "gpt-5.6-terra": {
          label: "GPT-5.6 Terra",
          provider: "openai",
          model: "gpt-5.6-terra",
          contextWindowTokens: 32_768,
          supportsThinking: true,
        },
        "gpt-5.6-luna": {
          label: "GPT-5.6 Luna",
          provider: "openai",
          model: "gpt-5.6-luna",
          contextWindowTokens: 32_768,
          supportsThinking: true,
        },
      },
      defaults: {
        profileId: "gpt-5.6-terra",
      },
    },
    requestRunner: {
      configPath: requestRunnerConfigPath,
    },
  };
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

describe("startAgentBridge lifecycle", () => {
  let wss: WebSocketServer | undefined;
  const handles: AgentBridgeHandle[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      await handle?.stop();
    }
    if (wss) {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss?.close(() => resolve()));
      wss = undefined;
    }
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
    vi.clearAllMocks();
  });

  test("reconnects and registers again after the bridge closes the socket", async () => {
    const port = await getFreePort();
    let connectionCount = 0;
    let registerCount = 0;

    wss = new WebSocketServer({ port, host: "127.0.0.1" });
    wss.on("connection", (socket) => {
      connectionCount += 1;
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type !== "register") {
          return;
        }
        registerCount += 1;
        socket.send(
          JSON.stringify({ type: "registered", agentId: "prod", ok: true }),
        );
        if (connectionCount === 1) {
          socket.close(1011, "server restart");
        }
      });
    });

    const handle = startAgentBridge({
      url: `ws://127.0.0.1:${port}`,
      token: "bridge-token",
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
      reconnectJitterRatio: 0,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      statusLogIntervalMs: 0,
    });
    handles.push(handle);

    await vi.waitFor(() => {
      expect(connectionCount).toBeGreaterThanOrEqual(2);
      expect(registerCount).toBeGreaterThanOrEqual(2);
    });

    expect(handle.getStatus().registered).toBe(true);
    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "agent-bridge.client",
      "reconnect.scheduled",
      expect.objectContaining({
        reason: "socket_closed",
        delayMs: 10,
      }),
    );
    expect(
      mocks.traceDebug.mock.calls.some(([, event]) => event === "registered"),
    ).toBe(false);
    expect(
      mocks.traceDebug.mock.calls.some(
        ([, event]) => event === "status.snapshot",
      ),
    ).toBe(false);
  });

  test("advertises the configured model catalog during registration", async () => {
    const port = await getFreePort();
    let registerMessage: Record<string, unknown> | undefined;
    const tempDir = await mkdtemp(join(tmpdir(), "agent-bridge-catalog-"));
    tempDirs.push(tempDir);
    const requestRunnerConfigPath = join(tempDir, "request-runner.config.json");
    await writeFile(
      requestRunnerConfigPath,
      JSON.stringify({
        models: {
          defaults: {
            profileId: "gpt-5.6-terra",
            steps: Object.fromEntries(
              REQUEST_INVOKED_STEP_IDS.map((stepId) => [stepId, stepId]),
            ),
          },
        },
        context: {
          outputReserveTokens: 4_096,
          safetyReserveTokens: 1_200,
          attachmentReserveTokens: 1_024,
        },
        steps: Object.fromEntries(
          REQUEST_INVOKED_STEP_IDS.map((stepId) => [
            stepId,
            { timeoutMs: 90_000 },
          ]),
        ),
      }),
    );

    wss = new WebSocketServer({ port, host: "127.0.0.1" });
    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type !== "register") {
          return;
        }
        registerMessage = message;
        socket.send(
          JSON.stringify({ type: "registered", agentId: "dev", ok: true }),
        );
      });
    });

    const handle = startAgentBridge({
      runtimeConfig: createRuntimeConfig(requestRunnerConfigPath),
      url: `ws://127.0.0.1:${port}`,
      token: "bridge-token",
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
    });
    handles.push(handle);

    await vi.waitFor(() => {
      expect(handle.getStatus().registered).toBe(true);
    });

    expect(registerMessage).toEqual({
      type: "register",
      agentId: "dev",
      features: ["request_steering_v1"],
      modelCatalog: {
        schemaVersion: 1,
        defaultProfileId: "gpt-5.6-terra",
        profiles: [
          {
            id: "gpt-5.6-terra",
            label: "GPT-5.6 Terra",
            providerId: "openai",
            provider: "openai",
            model: "gpt-5.6-terra",
            supportsThinking: true,
            capabilities: {
              inputModalities: ["text"],
              outputModalities: ["text"],
            },
            supportsImageInput: false,
          },
          {
            id: "gpt-5.6-luna",
            label: "GPT-5.6 Luna",
            providerId: "openai",
            provider: "openai",
            model: "gpt-5.6-luna",
            supportsThinking: true,
            capabilities: {
              inputModalities: ["text"],
              outputModalities: ["text"],
            },
            supportsImageInput: false,
          },
        ],
      },
    });
  });

  test("routes steering only while the correlated request is active", async () => {
    const port = await getFreePort();
    let bridgeSocket: import("ws").WebSocket | undefined;
    let steeringInbox:
      | import("../request/request-steering.js").RequestSteeringInbox
      | undefined;
    const acknowledgements: Record<string, unknown>[] = [];
    let releaseRequest: (() => void) | undefined;
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    mocks.handleRunRequest.mockImplementationOnce(
      async (_ws, _message, options) => {
        steeringInbox = options.requestSteering;
        await requestReleased;
      },
    );

    wss = new WebSocketServer({ port, host: "127.0.0.1" });
    wss.on("connection", (socket) => {
      bridgeSocket = socket;
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === "register") {
          expect(message.features).toEqual(["request_steering_v1"]);
          socket.send(
            JSON.stringify({ type: "registered", agentId: "dev", ok: true }),
          );
          socket.send(
            JSON.stringify({
              type: "run_request",
              requestId: "request-steering",
              sessionId: "session-steering",
              input: "Start the work",
            }),
          );
          return;
        }
        if (message.type === "steer_ack") {
          acknowledgements.push(message);
        }
      });
    });

    const handle = startAgentBridge({
      url: `ws://127.0.0.1:${port}`,
      token: "bridge-token",
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
    });
    handles.push(handle);

    await vi.waitFor(() => {
      expect(mocks.handleRunRequest).toHaveBeenCalledTimes(1);
      expect(steeringInbox).toBeDefined();
    });
    bridgeSocket?.send(
      JSON.stringify({
        type: "steer_request",
        requestId: "request-steering",
        steerId: "steer-1",
        text: "Use the shorter format instead",
      }),
    );

    await vi.waitFor(() => {
      expect(acknowledgements).toContainEqual({
        type: "steer_ack",
        requestId: "request-steering",
        steerId: "steer-1",
        accepted: true,
        acceptedSequence: 1,
      });
      expect(steeringInbox?.snapshot().updates).toEqual([
        {
          steerId: "steer-1",
          sequence: 1,
          text: "Use the shorter format instead",
        },
      ]);
    });

    releaseRequest?.();
    await vi.waitFor(() => {
      expect(mocks.traceDebug).toHaveBeenCalledWith(
        "agent-bridge.request_steering",
        "request.closed",
        expect.objectContaining({ requestId: "request-steering" }),
      );
    });
    bridgeSocket?.send(
      JSON.stringify({
        type: "steer_request",
        requestId: "request-steering",
        steerId: "steer-2",
        text: "This arrived too late",
      }),
    );
    await vi.waitFor(() => {
      expect(acknowledgements).toContainEqual({
        type: "steer_ack",
        requestId: "request-steering",
        steerId: "steer-2",
        accepted: false,
        reason: "request_not_active",
      });
    });
  });

  test("dispatches run requests through one bound environment handler", async () => {
    const port = await getFreePort();
    const requestHandler = {
      handle: vi.fn(async () => {}),
    };

    wss = new WebSocketServer({ port, host: "127.0.0.1" });
    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type !== "register") {
          return;
        }
        socket.send(
          JSON.stringify({ type: "registered", agentId: "dev", ok: true }),
        );
        socket.send(
          JSON.stringify({
            type: "run_request",
            requestId: "request-bound-handler",
            sessionId: "session-bound-handler",
            input: "Use the bound handler",
          }),
        );
      });
    });

    const handle = startAgentBridge({
      url: `ws://127.0.0.1:${port}`,
      token: "bridge-token",
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      requestHandler,
    });
    handles.push(handle);

    await vi.waitFor(() => {
      expect(requestHandler.handle).toHaveBeenCalledTimes(1);
    });
    expect(requestHandler.handle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "run_request",
        requestId: "request-bound-handler",
      }),
      expect.objectContaining({
        toolApprovalController: expect.any(Object),
        requestSteering: expect.any(Object),
      }),
    );
    expect(mocks.handleRunRequest).not.toHaveBeenCalled();
  });

  test("terminates stale sockets and reconnects when heartbeat times out", async () => {
    const port = await getFreePort();
    let connectionCount = 0;

    wss = new WebSocketServer({ port, host: "127.0.0.1" });
    wss.on("connection", (socket) => {
      connectionCount += 1;
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === "register") {
          socket.send(
            JSON.stringify({ type: "registered", agentId: "prod", ok: true }),
          );
        }
      });
    });

    const handle = startAgentBridge({
      url: `ws://127.0.0.1:${port}`,
      token: "bridge-token",
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
      reconnectJitterRatio: 0,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 1,
      statusLogIntervalMs: 0,
    });
    handles.push(handle);

    await vi.waitFor(() => {
      expect(connectionCount).toBeGreaterThanOrEqual(2);
    });

    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "agent-bridge.client",
      "heartbeat.timeout",
      expect.objectContaining({
        heartbeatTimeoutMs: 1,
      }),
    );
  });

  test("keeps routine lifecycle traces behind explicit opt-in", async () => {
    const port = await getFreePort();

    wss = new WebSocketServer({ port, host: "127.0.0.1" });
    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === "register") {
          socket.send(
            JSON.stringify({ type: "registered", agentId: "prod", ok: true }),
          );
        }
      });
    });

    const handle = startAgentBridge({
      url: `ws://127.0.0.1:${port}`,
      token: "bridge-token",
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      statusLogIntervalMs: 0,
      lifecycleTraceEnabled: true,
    });
    handles.push(handle);

    await vi.waitFor(() => {
      expect(handle.getStatus().registered).toBe(true);
    });

    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "agent-bridge.client",
      "connect.start",
      expect.objectContaining({ reason: "initial" }),
    );
    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "agent-bridge.client",
      "registered",
      expect.objectContaining({ registered: true }),
    );
    expect(mocks.traceDebug).toHaveBeenCalledWith(
      "agent-bridge.client",
      "status.snapshot",
      expect.objectContaining({ reason: "registered" }),
    );
  });
});
