import type WebSocket from "ws";
import { SPARK_SESSION_ID } from "../sessions/spark-session.js";
import type { RunRequestMessage } from "../runtime/request/contracts.js";
import type { SparkChatAccess } from "../runtime/spark-chat/contracts.js";
import { publicSparkChatAdmissionFailure } from "../runtime/spark-chat/service.js";

function isSparkOpenMessage(message: Record<string, unknown>): boolean {
  if (typeof message.correlationId !== "string") return false;
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(message.correlationId)) return false;
  return Object.keys(message).every((key) => key === "type" || key === "correlationId");
}

/** The runtime opens its canonical companion; clients cannot supply its identity. */
export async function handleSparkChatBridgeMessage(
  socket: WebSocket,
  message: Record<string, unknown>,
  access: SparkChatAccess | undefined,
): Promise<boolean> {
  if (message.type !== "spark.chat.open.request") return false;
  const response = {
    type: "spark.chat.open.response",
    correlationId: typeof message.correlationId === "string" ? message.correlationId : "",
  };
  if (!isSparkOpenMessage(message)) {
    socket.send(JSON.stringify({ ...response, ok: false, error: "invalid_spark_chat_request" }));
    return true;
  }
  if (!access) {
    socket.send(JSON.stringify({ ...response, ok: false, error: "spark_chat_unsupported" }));
    return true;
  }
  try {
    const state = await access.open();
    socket.send(JSON.stringify({ ...response, ok: true, ...state }));
  } catch (error) {
    socket.send(JSON.stringify({ ...response, ok: false, ...publicSparkChatAdmissionFailure(error) }));
  }
  return true;
}

/** A relay has already checked the requested mode against the device's grant. */
export async function resolveBridgeSparkRequest(
  access: SparkChatAccess | undefined,
  request: RunRequestMessage,
): Promise<RunRequestMessage> {
  if (request.sessionId !== SPARK_SESSION_ID) return request;
  if (!access) throw new Error("spark_chat_unsupported");
  // Re-read at each new run. A changed mode must never expand the relay grant.
  return access.resolve(SPARK_SESSION_ID, request, { requireMatchingPermissionMode: true });
}
