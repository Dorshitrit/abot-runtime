import type { ServerResponse } from "node:http";
import type WebSocket from "ws";

import type { RunRequestMessage } from "../../runtime/request/contracts.js";
import type { SchedulerRun } from "../../runtime/scheduler/contracts.js";
import type { RuntimeRequestOptions } from "../../runtime/composition.js";
import {
  createRequestSteeringInbox,
  type RequestSteeringInbox,
} from "../../runtime/request/request-steering.js";
import type {
  ActiveRequest,
  JsonObject,
  RuntimeEnvironment,
} from "./contracts.js";
import { getNumber, getString, sendJson } from "./http.js";
import { RealtimeClientHub } from "./realtime-hub.js";
import { PendingToolApprovals } from "./pending-tool-approvals.js";
import { createWorkspaceChangeNotifier } from "./workspace-notifications.js";
import type { LocalPendingToolApproval } from "../../runtime/local-host/request-approval-contracts.js";
import { attachApprovalRequest } from "./approval-request-attachment.js";

function createRequestId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `web-${Date.now()}-${random}`;
}

export class LocalRequestExecution {
  private readonly activeRequests = new Map<string, ActiveRequest>();
  readonly toolApprovals: PendingToolApprovals;

  constructor(private readonly realtime: RealtimeClientHub) {
    const notify = createWorkspaceChangeNotifier(realtime);
    this.toolApprovals = new PendingToolApprovals(
      (requestId) => this.activeRequests.get(requestId),
      (requestId) => {
        const active = this.activeRequests.get(requestId);
        if (!active) return;
        notify(active.environmentId, ["approvals"]);
      },
    );
  }

  scheduledRequestOptions(run: SchedulerRun): RuntimeRequestOptions {
    const requestSteering = createRequestSteeringInbox({
      requestId: run.requestId,
    });
    this.activeRequests.set(run.requestId, {
      requestId: run.requestId,
      sessionId: run.sessionId,
      environmentId: run.environmentId,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      lastEventName: "request.started",
      events: [],
      finalState: null,
      requestSteering,
    });
    return {
      toolApprovalController: this.toolApprovals,
      requestSteering,
    };
  }

  publishScheduled(payload: JsonObject): void {
    const isTerminal =
      payload.type === "completed" || payload.type === "failed";
    const outbound =
      isTerminal && payload.requestOrigin !== "approval"
        ? { ...payload, requestOrigin: "schedule" }
        : payload;
    if (payload.sessionDeleted !== true) this.publish(outbound);
    if (isTerminal) {
      this.activeRequests.delete(getString(payload.requestId));
    }
  }

  async start(
    res: ServerResponse,
    body: JsonObject,
    environmentId: string,
    environment: RuntimeEnvironment,
  ): Promise<void> {
    const text = getString(body.text).trim();
    const sessionId = getString(body.sessionId).trim();
    if (!text || !sessionId) {
      sendJson(res, 400, {
        ok: false,
        error: !text ? "text_required" : "sessionId_required",
      });
      return;
    }
    const requestId = createRequestId();
    const requestSteering = createRequestSteeringInbox({ requestId });
    const request: RunRequestMessage = {
      type: "run_request",
      requestId,
      sessionId,
      text,
      agentMode: body.agentMode,
      modelPreference: body.modelPreference,
      toolPermissionMode: body.toolPermissionMode,
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
    };
    this.activeRequests.set(requestId, {
      requestId,
      sessionId,
      environmentId,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      lastEventName: "request.started",
      events: [],
      finalState: null,
      requestSteering,
    });
    void this.run(
      environment,
      request,
      environmentId,
      sessionId,
      requestSteering,
    )
      .catch((error) => {
        this.publish({
          type: "failed",
          requestId,
          sessionId,
          environment: environmentId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.activeRequests.delete(requestId));
    sendJson(res, 200, { ok: true, requestId, sessionId });
  }

  activeReplay(requestId: string, afterSeq: number): JsonObject | undefined {
    const active = this.activeRequests.get(requestId);
    if (!active) return undefined;
    return {
      ok: true,
      requestId: active.requestId,
      events: active.events.filter(
        (event) => getNumber(event.eventSequence) > afterSeq,
      ),
      finalState: active.finalState,
    };
  }

  activeReplayForSession(
    requestId: string,
    sessionId: string,
    environmentId: string,
  ): readonly JsonObject[] | undefined {
    const active = this.activeRequests.get(requestId);
    if (!active || active.sessionId !== sessionId) return undefined;
    if (active.environmentId !== environmentId) return undefined;
    return active.events;
  }

  healthDetails(): JsonObject[] {
    return [...this.activeRequests.values()].map((request) => ({
      requestId: request.requestId,
      sessionId: request.sessionId,
      environment: request.environmentId,
      startedAt: request.startedAt,
      lastEventAt: request.lastEventAt,
      lastEventName: request.lastEventName,
      idleMs: Date.now() - request.lastEventAt,
    }));
  }

  async handleSteer(
    message: JsonObject,
    resolveEnvironment: (id: string) => RuntimeEnvironment,
  ): Promise<JsonObject> {
    const requestId = getString(message.requestId).trim();
    const steerId = getString(message.steerId).trim();
    const text = getString(message.text).trim();
    const active = requestId ? this.activeRequests.get(requestId) : undefined;
    const steer = active
      ? resolveEnvironment(active.environmentId).requests.steer
      : undefined;
    const result =
      (steer
        ? await steer(requestId, { steerId, text })
        : active?.requestSteering.append({ steerId, text })) ??
      ({ ok: false, reason: "request_not_active" } as const);
    return result.ok
      ? {
          type: "steer_ack",
          requestId,
          steerId,
          accepted: true,
          acceptedSequence: result.update.sequence,
        }
      : {
          type: "steer_ack",
          requestId,
          steerId,
          accepted: false,
          reason: result.reason,
        };
  }

  resolveToolApproval(message: JsonObject): void {
    this.toolApprovals.resolveRealtime(message);
  }

  attachToolApproval(
    environmentId: string,
    environment: RuntimeEnvironment,
    pending: LocalPendingToolApproval,
    events: readonly JsonObject[],
  ): Promise<void> {
    return attachApprovalRequest({
      environmentId,
      environment,
      pending,
      events,
      activeRequests: this.activeRequests,
      toolApprovals: this.toolApprovals,
      publish: (data) =>
        this.publishRaw(data, { environmentId, sessionId: pending.sessionId }),
    });
  }

  private async run(
    environment: RuntimeEnvironment,
    request: RunRequestMessage,
    environmentId: string,
    sessionId: string,
    requestSteering: RequestSteeringInbox,
  ): Promise<void> {
    const localWs = {
      send: (data: string) =>
        this.publishRaw(data, { environmentId, sessionId }),
    } as WebSocket;
    await environment.requests.handle(localWs, request, {
      toolApprovalController: this.toolApprovals,
      requestSteering,
      durableApprovals: true,
    });
  }

  private publishRaw(
    data: string,
    context: { environmentId: string; sessionId: string },
  ): void {
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return;
      this.publish({
        ...(parsed as JsonObject),
        sessionId: context.sessionId,
        environment: context.environmentId,
      });
    } catch {
      this.publish({
        type: "control",
        name: "local_runtime_invalid_event",
        output: data,
      });
    }
  }

  private publish(payload: JsonObject): void {
    const requestId = getString(payload.requestId);
    const active = requestId ? this.activeRequests.get(requestId) : undefined;
    if (active) {
      active.lastEventAt = Date.now();
      active.lastEventName =
        getString(payload.name) || getString(payload.type) || "event";
      active.events.push(payload);
      if (payload.type === "completed") {
        active.finalState = {
          status: "completed",
          output: getString(payload.output),
          completedAt: Date.now(),
        };
      }
      if (payload.type === "failed") {
        active.finalState = {
          status: "failed",
          error: getString(payload.error),
          completedAt: Date.now(),
        };
      }
    }
    this.realtime.broadcast(payload);
    if (payload.name === "request.lifecycle.changed") {
      this.realtime.broadcast({
        type: "workspace_changed",
        environment: payload.environment,
        resources: ["approvals", "sessions"],
      });
    }
  }
}
