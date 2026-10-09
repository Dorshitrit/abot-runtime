import type WebSocket from "ws";

import {
  createRequestControlDiagnosticId,
  diagnosticErrorType,
  traceRequestControl,
} from "../runtime/observability/request-control-diagnostics.js";
import type { RuntimeRequestHandler } from "../runtime/composition.js";
import {
  createRequestSteeringInbox,
  type RequestSteeringAppendResult,
  type RequestSteeringInbox,
} from "../runtime/request/request-steering.js";

type ActiveSteeringRequest = Readonly<{
  inbox: RequestSteeringInbox;
  requestId: string;
  inboxId: string;
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

export function createBridgeRequestSteeringRegistry(
  steer?: RuntimeRequestHandler["steer"],
): BridgeRequestSteeringRegistry {
  const active = new Map<string, ActiveSteeringRequest>();

  return Object.freeze({
    async close(requestId, inbox) {
      const current = active.get(requestId);
      if (current?.inbox === inbox) {
        active.delete(requestId);
        traceRequestControl(LOG_SCOPE, "request.removed", {
          requestId,
          inboxId: current.inboxId,
          source: "bridge_handler_settled",
        });
      }
      await inbox.close();
      traceRequestControl(LOG_SCOPE, "request.closed", {
        requestId,
        inboxId: current?.inboxId,
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
      const diagnosticScope = {
        requestId,
        steerId,
        inboxId: current?.inboxId,
        registryPresent: Boolean(current),
        ownerSteerAvailable: Boolean(steer),
        textLength: text.length,
      };
      traceRequestControl(LOG_SCOPE, "message.received", diagnosticScope);
      let result: RequestSteeringAppendResult;
      try {
        result =
          (steer && current
            ? await steer(requestId, { steerId, text })
            : current?.inbox.append({ steerId, text })) ??
          Object.freeze({
            ok: false as const,
            reason: "request_not_active" as const,
          });
      } catch (error) {
        traceRequestControl(LOG_SCOPE, "message.failed", {
          ...diagnosticScope,
          errorType: diagnosticErrorType(error),
        });
        throw error;
      }

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
      traceRequestControl(
        LOG_SCOPE,
        result.ok ? "message.accepted" : "message.rejected",
        {
          ...diagnosticScope,
          registryUnchanged: active.get(requestId) === current,
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
      traceRequestControl(LOG_SCOPE, "ack.dispatch_attempted", {
        ...diagnosticScope,
        accepted: result.ok,
        readyState: ws.readyState,
      });
      try {
        await sendJson(ws, response);
      } catch (error) {
        traceRequestControl(LOG_SCOPE, "ack.dispatch_failed", {
          ...diagnosticScope,
          errorType: diagnosticErrorType(error),
        });
        throw error;
      }
      return true;
    },
    open(requestId) {
      if (!requestId.trim()) {
        throw new Error("request_steering_request_id_required");
      }
      if (active.has(requestId)) {
        throw new Error("request_steering_request_already_active");
      }
      const inboxId = createRequestControlDiagnosticId("inbox");
      const inbox = createRequestSteeringInbox({
        requestId,
        diagnostics: { inboxId, origin: "bridge_projection" },
      });
      active.set(requestId, Object.freeze({ inbox, requestId, inboxId }));
      traceRequestControl(LOG_SCOPE, "request.opened", {
        requestId,
        inboxId,
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
