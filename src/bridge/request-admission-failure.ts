import type WebSocket from "ws";
import { isAgentSessionAccessError } from "./agent-session-access.js";
import { getSessionAdmissionErrorCode } from "../runtime/request/session-busy.js";
import { RuntimeCommandInputError } from "../runtime/commands/catalog.js";
import { isAutomationSessionLockedError } from "../sessions/automation-session-origin.js";
import { getSparkChatAdmissionErrorCode } from "../runtime/spark-chat/service.js";

function admissionFailureCode(error: unknown): string | undefined {
  if (error instanceof RuntimeCommandInputError) return error.code;
  if (isAgentSessionAccessError(error)) return error.message;
  if (isAutomationSessionLockedError(error)) return "automation_session_locked";
  return getSessionAdmissionErrorCode(error) ?? getSparkChatAdmissionErrorCode(error);
}

/** A rejected request has no persisted run, but its Bridge caller needs a terminal frame. */
export function publishRequestAdmissionFailure(
  socket: WebSocket,
  message: Record<string, unknown>,
  error: unknown,
): void {
  if (message.type !== "run_request") return;
  const code = admissionFailureCode(error);
  if (!code) return;
  socket.send(JSON.stringify({
    type: "failed",
    requestId: String(message.requestId ?? ""),
    sessionId: String(message.sessionId ?? ""),
    error: code,
    ...(message.command !== undefined ? { requestKind: "command", command: message.command, name: "command.failed" } : {}),
  }));
}
