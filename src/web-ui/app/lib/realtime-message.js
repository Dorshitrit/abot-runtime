import { getRecord } from "./event-presentation.js";
import { textOf } from "./text-format.js";

export function normalizeRealtimeMessage(raw) {
  const message = raw && typeof raw === "object" ? raw : {};
  const payload = getRecord(message.payload);
  return {
    ...message,
    ...(payload || {}),
    type: textOf(message.type),
    rawType: textOf(message.rawType || message.type),
    requestId: textOf(message.requestId),
    sessionId: textOf(message.sessionId),
    seqNo:
      typeof message.seqNo === "number"
        ? message.seqNo
        : typeof message.eventSequence === "number"
          ? message.eventSequence
          : undefined,
    name: textOf(message.name),
    tool: textOf(message.tool),
    status: textOf(message.status),
    phase: textOf(message.phase),
  };
}
