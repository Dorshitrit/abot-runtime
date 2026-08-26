import type WebSocket from "ws";

import { traceDebug } from "../runtime/observability/debug-logger.js";
import {
  createRequestSteeringInbox,
  type RequestSteeringInbox,
} from "../runtime/request/request-steering.js";

type ActiveSteeringRequest = Readonly<{
  inbox: RequestSteeringInbox;
  requestId: string;
}>;

export type BridgeRequestSteeringRegistry = Readonly<{
  close(requestId: string, inbox: RequestSteeringInbox): Promise<void>;
  handleMessage(
    ws: WebSocket,
    message: Record<string, unknown>,
  ): Promise<boolean>;
  open(requestId: string): RequestSteeringInbox;
}>;

const LOG_SCOPE = "agent-bridge.request_steering";

export function createBridgeRequestSteeringRegistry(): BridgeRequestSteeringRegistry {
  const active = new Map<string, ActiveSteeringRequest>();

  return Object.freeze({
    async close(requestId, inbox) {
      const current = active.get(requestId);
      if (current?.inbox === inbox) {
        active.delete(requestId);
      }
      await inbox.close();
      traceDebug(LOG_SCOPE, "request.closed", {
        requestId,
        activeRequestCount: active.size,
      });
    },
    async handleMessage(ws, message) {
      if (message.type !== "steer_request") {
        return false;
      }
      const requestId = readString(message.requestId).trim();
      const steerId = readString(message.steerId).trim();
      const text = readString(message.text).trim();
      const current = active.get(requestId);
      const result =
        current?.inbox.append({ steerId, text }) ??
        Object.freeze({
          ok: false as const,
          reason: "request_not_active" as const,
        });

      const response = result.ok
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
      await sendJson(ws, response);
      traceDebug(
        LOG_SCOPE,
        result.ok ? "message.accepted" : "message.rejected",
        {
          requestId,
          steerId,
          accepted: result.ok,
          ...(result.ok
            ? {
                acceptedSequence: result.update.sequence,
                duplicate: result.duplicate,
                textLength: text.length,
              }
            : { reason: result.reason }),
        },
      );
      return true;
    },
    open(requestId) {
      if (!requestId.trim()) {
        throw new Error("request_steering_request_id_required");
      }
      if (active.has(requestId)) {
        throw new Error("request_steering_request_already_active");
      }
      const inbox = createRequestSteeringInbox({ requestId });
      active.set(requestId, Object.freeze({ inbox, requestId }));
      traceDebug(LOG_SCOPE, "request.opened", {
        requestId,
        activeRequestCount: active.size,
      });
      return inbox;
    },
  });
}

async function sendJson(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify(payload), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
