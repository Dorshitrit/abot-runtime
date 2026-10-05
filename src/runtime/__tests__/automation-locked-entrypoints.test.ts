import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { ServerResponse } from "node:http";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createFileSessionStore } from "../adapters/file-session-store.js";
import { createSessionLifecycleStore } from "../session/session-lifecycle-store.js";
import type { RuntimeEnvironmentServices } from "../composition.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import { dispatchLocalServiceCall } from "../local-host/app-service-dispatch.js";
import { createLockedRequestSteeringInbox } from "../request/locked-request-steering.js";
import { handleRuntimeReplayBridgeMessage } from "../../bridge/runtime-replay.js";
import { startAgentBridge } from "../../bridge/start-agent-bridge.js";
import { LocalRequestExecution } from "../../web-ui/local-runtime/request-execution.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";

const directories: string[] = [];

async function lockedStore() {
  const sessionsDir = await mkdtemp(join(tmpdir(), "automation-entries-"));
  directories.push(sessionsDir);
  const sessions = createSessionLifecycleStore(
    createFileSessionStore({ sessionsDir }),
  ).store;
  await sessions.createAutomationSession!("internal", {
    kind: "automation_node_v1",
    automationId: "automation-1",
    runId: "run-1",
    nodeId: "node-1",
    attemptId: "attempt-1",
  });
  return sessions;
}

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("locked automation session entry points", () => {
  test("Web send and live steering reject before dispatch", async () => {
    const sessions = await lockedStore();
    const requests = new LocalRequestExecution(new RealtimeClientHub());
    const send = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    const handle = vi.fn();
    const steer = vi.fn();
    const environment = {
      services: { sessions },
      requests: { handle, steer },
    } as unknown as RuntimeEnvironment;

    await requests.start(
      send,
      { text: "inject", sessionId: "internal" },
      "dev",
      environment,
    );
    expect(send.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
    expect(send.end).toHaveBeenCalledWith(
      JSON.stringify({ ok: false, error: "automation_session_locked" }),
    );
    expect(handle).not.toHaveBeenCalled();

    requests.scheduledRequestOptions({
      requestId: "request-internal",
      sessionId: "internal",
      environmentId: "dev",
    } as SchedulerRun);
    await expect(
      requests.handleSteer(
        { requestId: "request-internal", steerId: "steer-1", text: "inject" },
        () => environment,
      ),
    ).resolves.toMatchObject({
      accepted: false,
      reason: "automation_session_locked",
    });
    expect(steer).not.toHaveBeenCalled();
  });

  test("managed RPC and Bridge mutation endpoints cannot modify a node transcript", async () => {
    const sessions = await lockedStore();
    const services = { sessions } as RuntimeEnvironmentServices;
    await expect(
      dispatchLocalServiceCall(services, "sessions.appendMessage", [
        "internal",
        "user",
        "injected",
      ]),
    ).rejects.toThrow("automation_session_locked");
    await expect(
      dispatchLocalServiceCall(services, "sessions.clearSessionMessages", [
        "internal",
      ]),
    ).rejects.toThrow("automation_session_locked");
    await expect(
      dispatchLocalServiceCall(services, "sessions.createAutomationSession", [
        "external",
        { kind: "automation_node_v1" },
      ]),
    ).rejects.toThrow("local_runtime_method_unknown");

    const responses: Record<string, unknown>[] = [];
    const socket = {
      send(data: string) {
        responses.push(JSON.parse(data) as Record<string, unknown>);
      },
    } as WebSocket;
    expect(
      await handleRuntimeReplayBridgeMessage(
        socket,
        {
          type: "session.delete.request",
          correlationId: "delete-1",
          sessionId: "internal",
        },
        { sessionStore: sessions },
      ),
    ).toBe(true);
    expect(responses[0]).toMatchObject({ ok: false });
    await expect(sessions.assertInteractiveSession!("internal")).rejects.toThrow(
      "automation_session_locked",
    );
  });

  test("Bridge run_request rejects a locked session before opening a request", async () => {
    const sessions = await lockedStore();
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const responses: Record<string, unknown>[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === "register") {
          socket.send(JSON.stringify({ type: "registered", ok: true }));
          socket.send(
            JSON.stringify({
              type: "run_request",
              requestId: "external-request",
              sessionId: "internal",
              text: "inject",
            }),
          );
        } else {
          responses.push(message);
        }
      });
    });
    const run = vi.fn(async () => undefined);
    const bridge = startAgentBridge({
      url: `ws://127.0.0.1:${port}`,
      token: "test-token",
      sessionStore: sessions,
      requestHandler: { handle: run },
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
    });
    try {
      await vi.waitFor(() =>
        expect(responses).toContainEqual(
          expect.objectContaining({
            type: "failed",
            requestId: "external-request",
            error: "automation_session_locked",
          }),
        ),
      );
      expect(run).not.toHaveBeenCalled();
    } finally {
      await bridge.stop();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a locked inbox cannot accept steering, while an ordinary session remains mutable", async () => {
    const sessions = await lockedStore();
    const inbox = createLockedRequestSteeringInbox("request-internal");
    expect(inbox.append({ steerId: "steer-1", text: "inject" })).toEqual({
      ok: false,
      reason: "automation_session_locked",
    });
    await inbox.close();

    await sessions.appendMessage("ordinary", "user", "hello");
    await sessions.assertInteractiveSession!("ordinary");
    expect((await sessions.getSessionById("ordinary"))?.messageCount).toBe(1);
  });
});
