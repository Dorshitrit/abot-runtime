import type WebSocket from "ws";

import type { JsonObject, LocalRuntimeBackendOptions } from "./contracts.js";
import { RuntimeEnvironmentRegistry } from "./environment-registry.js";
import { getNumber, getString, requestEnvironmentId } from "./http.js";
import { RealtimeClientHub } from "./realtime-hub.js";
import { LocalRequestExecution } from "./request-execution.js";
import { ManagedWebToolApprovals, type WebToolApprovalAcceptedObserver } from "./managed-tool-approvals.js";
import { diagnosticErrorType } from "../../runtime/observability/request-control-diagnostics.js";
import { traceWebRequestControl } from "./request-control-observation.js";

export class LocalRealtimeController {
  private readonly approvals: ManagedWebToolApprovals;
  constructor(
    private readonly options: LocalRuntimeBackendOptions,
    private readonly environments: RuntimeEnvironmentRegistry,
    private readonly requests: LocalRequestExecution,
    private readonly clients: RealtimeClientHub,
    onApprovalAccepted?: WebToolApprovalAcceptedObserver,
  ) {
    this.approvals = new ManagedWebToolApprovals(
      (id) => environments.get(id),
      requests,
      onApprovalAccepted,
    );
  }

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
    if (message.type === "notification_presence") {
      this.clients.updatePresence(client, message);
      return;
    }
    if (message.type === "tool_approval_response") {
      const accepted = await this.approvals.resolveRealtime(
        message,
        this.options.defaultEnvironmentId ?? "",
      );
      this.clients.send(client, {
        type: "tool_approval_ack",
        approvalId: message.approvalId,
        accepted,
        environment: message.environment,
        sessionId: message.sessionId,
        ...(accepted ? {} : { reason: "approval_conflict_or_unavailable" }),
      });
      return;
    }
    if (message.type === "steer_request") {
      const acknowledgement = await this.requests.handleSteer(message, (id) =>
        this.environments.get(id),
      );
      traceWebRequestControl("steer.ack_dispatch_attempted", {
        requestId: getString(acknowledgement.requestId),
        steerId: getString(acknowledgement.steerId),
        accepted: acknowledgement.accepted === true,
        reason: getString(acknowledgement.reason) || undefined,
        socketReadyState: client.readyState,
      });
      this.clients.send(client, acknowledgement);
      return;
    }
    if (message.type !== "resume_request") return;
    try {
      await this.resume(client, message);
    } catch (error) {
      traceWebRequestControl("resume.failed", {
        requestId: getString(message.requestId),
        requestedEnvironment: getString(message.environment),
        errorType: diagnosticErrorType(error),
      });
      throw error;
    }
  }

  private async resume(client: WebSocket, message: JsonObject): Promise<void> {
    const requestId = getString(message.requestId);
    if (!requestId) return;
    const environmentId = requestEnvironmentId(
      new URL("/", "http://localhost"),
      message,
      this.options.defaultEnvironmentId,
    );
    const startedAt = Date.now();
    traceWebRequestControl("resume.received", {
      requestId,
      environmentId,
      afterSeq: getNumber(message.afterSeq),
    });
    const environment = this.environments.get(environmentId);
    let replay = await environment.services.sessions.getRequestReplayById(
      requestId,
      getNumber(message.afterSeq),
      getString(message.sessionId) || undefined,
    );
    if (!replay?.finalState) {
      await this.approvals.resume(environmentId, requestId, replay?.sessionId);
      replay = await environment.services.sessions.getRequestReplayById(
        requestId,
        getNumber(message.afterSeq),
        replay?.sessionId || getString(message.sessionId) || undefined,
      );
    }
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
    // A returned send call is not a browser delivery acknowledgement.
    traceWebRequestControl("resume.dispatch_returned", {
      requestId,
      environmentId,
      afterSeq: getNumber(message.afterSeq),
      replayFound: replay !== null && replay !== undefined,
      sessionId: replay?.sessionId,
      eventCount: replay?.events.length ?? 0,
      lifecycleStatus: replay?.lifecycle?.status,
      finalStateStatus: replay?.finalState?.status,
      socketReadyState: client.readyState,
      elapsedMs: Date.now() - startedAt,
    });
  }
}
