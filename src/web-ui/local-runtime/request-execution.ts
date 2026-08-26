import type { ServerResponse } from "node:http";
import type WebSocket from "ws";

import type { RunRequestMessage } from "../../runtime/request/contracts.js";
import {
  createRequestSteeringInbox,
  type RequestSteeringInbox,
} from "../../runtime/request/request-steering.js";
import type {
  ToolApprovalController,
  ToolApprovalDecision,
} from "../../runtime/ports.js";
import type {
  ActiveRequest,
  JsonObject,
  RuntimeEnvironment,
} from "./contracts.js";
import { getNumber, getString, sendJson } from "./http.js";
import { RealtimeClientHub } from "./realtime-hub.js";

type PendingToolApproval = {
  requestId: string;
  resolve: (decision: ToolApprovalDecision) => void;
};

function createRequestId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `web-${Date.now()}-${random}`;
}

export class LocalRequestExecution {
  private readonly activeRequests = new Map<string, ActiveRequest>();
  private readonly pendingToolApprovals = new Map<
    string,
    PendingToolApproval
  >();

  constructor(private readonly realtime: RealtimeClientHub) {}

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

  handleSteer(message: JsonObject): JsonObject {
    const requestId = getString(message.requestId).trim();
    const steerId = getString(message.steerId).trim();
    const text = getString(message.text).trim();
    const active = requestId ? this.activeRequests.get(requestId) : undefined;
    const result =
      active?.requestSteering.append({ steerId, text }) ??
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
    const approvalId = getString(message.approvalId);
    if (!approvalId) return;
    const pending = this.pendingToolApprovals.get(approvalId);
    if (!pending) return;
    pending.resolve({
      approved: message.approved === true,
      reason: getString(message.reason).trim() || undefined,
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
      toolApprovalController: this.createToolApprovalController(),
      requestSteering,
    });
  }

  private createToolApprovalController(): ToolApprovalController {
    return {
      requestToolApproval: (request, options) =>
        new Promise<ToolApprovalDecision>((resolve) => {
          if (options?.abortSignal?.aborted) {
            resolve({
              approved: false,
              reason: "Tool approval was cancelled.",
            });
            return;
          }
          const complete = (decision: ToolApprovalDecision) => {
            this.pendingToolApprovals.delete(request.approvalId);
            options?.abortSignal?.removeEventListener("abort", onAbort);
            resolve(decision);
          };
          const onAbort = () =>
            complete({
              approved: false,
              reason: "Tool approval was cancelled.",
            });
          options?.abortSignal?.addEventListener("abort", onAbort, {
            once: true,
          });
          this.pendingToolApprovals.set(request.approvalId, {
            requestId: request.requestId,
            resolve: complete,
          });
        }),
    };
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
  }
}
