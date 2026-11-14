import { once } from "node:events";
import { expect, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { startAgentBridge } from "../../../bridge/start-agent-bridge.js";
import { createInMemorySessionStore } from "../../adapters/in-memory-session-store.js";
import type { RuntimeRequestHandler } from "../../composition.js";
import type { PassiveLearningManagement } from "../../local-host/client-learning.js";
import type { PassiveLearningPreferences } from "../../passive-learning/contracts.js";
import { DEFAULT_LEARNING_PREFERENCES } from "../../passive-learning/store.js";
import type { RuntimeConfig } from "../../ports.js";
import { createSessionLifecycleStore } from "../../session/session-lifecycle-store.js";
import { createSparkChatAccess } from "../../spark-chat/service.js";

export function createSparkAccessFixture() {
  const sessions = createSessionLifecycleStore(createInMemorySessionStore()).store;
  let preferences: PassiveLearningPreferences = {
    ...DEFAULT_LEARNING_PREFERENCES,
    modelProfileId: "learning",
    proactiveModelProfileId: "spark",
  };
  const status = vi.fn(async () => ({ preferences }) as Awaited<
    ReturnType<PassiveLearningManagement["status"]>
  >);
  const config = {
    models: {
      providers: { local: { type: "ollama" } },
      profiles: {
        learning: { provider: "local", model: "learning", contextWindowTokens: 4096 },
        spark: { provider: "local", model: "spark", contextWindowTokens: 4096 },
      },
    },
  } satisfies Pick<RuntimeConfig, "models">;
  const access = createSparkChatAccess({
    sessions,
    config,
    passiveLearning: { status },
  });
  return {
    access, sessions, config, status,
    configure(next: Partial<PassiveLearningPreferences>) {
      preferences = { ...preferences, ...next };
    },
  };
}

export async function createBridgeSparkFixture(supported = true) {
  const source = createSparkAccessFixture();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const frames: Record<string, unknown>[] = [];
  let remote: WebSocket | undefined;
  let sequence = 0;
  server.on("connection", (socket) => {
    remote = socket;
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "register") {
        socket.send(JSON.stringify({ type: "registered", ok: true }));
      }
    });
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture_listener_missing");
  }
  const run = vi.fn<RuntimeRequestHandler["handle"]>(async () => {});
  const handler: RuntimeRequestHandler = {
    handle: run,
    ...(supported ? { sparkChat: source.access } : {}),
  };
  const bridge = startAgentBridge({
    url: `ws://127.0.0.1:${address.port}`,
    token: "fixture-token",
    requestHandler: handler,
    sessionStore: source.sessions,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 120_000,
    statusLogIntervalMs: 0,
  });
  async function dispose() {
    await bridge.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  try {
    await vi.waitFor(() => expect(bridge.getStatus().registered).toBe(true));
  } catch (error) {
    await dispose();
    throw error;
  }
  function send(frame: Record<string, unknown>) {
    if (!remote) throw new Error("fixture_not_connected");
    remote.send(JSON.stringify(frame));
  }
  async function waitForFrame(predicate: (frame: Record<string, unknown>) => boolean) {
    let found: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      found = frames.find(predicate);
      expect(found).toBeDefined();
    });
    return found!;
  }
  async function command(frame: Record<string, unknown>) {
    const correlationId = `spark-query-${++sequence}`;
    send({ ...frame, correlationId });
    return waitForFrame((reply) => reply.correlationId === correlationId);
  }
  return { ...source, frames, run, send, command, waitForFrame, dispose };
}
