import type WebSocket from "ws";

import type { JsonObject, LocalRuntimeBackendOptions } from "./contracts.js";
import { RuntimeEnvironmentRegistry } from "./environment-registry.js";
import { getNumber, getString, requestEnvironmentId } from "./http.js";
import { RealtimeClientHub } from "./realtime-hub.js";
import { LocalRequestExecution } from "./request-execution.js";

export class LocalRealtimeController {
  constructor(
    private readonly options: LocalRuntimeBackendOptions,
    private readonly environments: RuntimeEnvironmentRegistry,
    private readonly requests: LocalRequestExecution,
    private readonly clients: RealtimeClientHub,
  ) {}

  connect(client: WebSocket): void {
    this.clients.add(client);
    client.on("message", (data) => {
      void this.handleMessage(client, data.toString()).catch((error) => {
        this.clients.send(client, {
          type: "control",
          name: "local_runtime_realtime_error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  private async handleMessage(client: WebSocket, raw: string): Promise<void> {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const message = parsed as JsonObject;
    if (message.type === "tool_approval_response") {
      this.requests.resolveToolApproval(message);
      return;
    }
    if (message.type === "steer_request") {
      this.clients.send(
        client,
        await this.requests.handleSteer(message, (id) =>
          this.environments.get(id),
        ),
      );
      return;
    }
    if (message.type !== "resume_request") return;
    await this.resume(client, message);
  }

  private async resume(client: WebSocket, message: JsonObject): Promise<void> {
    const requestId = getString(message.requestId);
    if (!requestId) return;
    const environmentId = requestEnvironmentId(
      new URL("/", "http://localhost"),
      message,
      this.options.defaultEnvironmentId,
    );
    const environment = this.environments.get(environmentId);
    const replay = await environment.services.sessions.getRequestReplayById(
      requestId,
      getNumber(message.afterSeq),
    );
    for (const event of replay?.events ?? []) {
      this.clients.send(client, { ...event, environment: environmentId });
    }
    if (replay?.finalState?.status === "completed") {
      this.clients.send(client, {
        type: "completed",
        requestId,
        sessionId: replay.sessionId,
        environment: environmentId,
        output: replay.finalState.output,
      });
    }
    if (replay?.finalState?.status === "failed") {
      this.clients.send(client, {
        type: "failed",
        requestId,
        sessionId: replay.sessionId,
        environment: environmentId,
        error: replay.finalState.error,
      });
    }
  }
}
