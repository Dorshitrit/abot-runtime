import type WebSocket from "ws";
import { getSessionAdmissionErrorCode } from "../runtime/request/session-busy.js";

/** A rejected request has no persisted run, but its Bridge caller needs a terminal frame. */
export function publishRequestAdmissionFailure(
  socket: WebSocket,
  message: Record<string, unknown>,
  error: unknown,
): void {
  if (message.type !== "run_request") return;
  const code = getSessionAdmissionErrorCode(error);
  if (!code) return;
  socket.send(JSON.stringify({
    type: "failed",
    requestId: String(message.requestId ?? ""),
    sessionId: String(message.sessionId ?? ""),
    error: code,
  }));
}
