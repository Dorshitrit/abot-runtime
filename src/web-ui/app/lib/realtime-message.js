import { getRecord } from "./event-presentation.js";
import { textOf } from "./text-format.js";

const contextSequenceSource = Symbol("context sequence source");

export function contextTransportSequenceDomain(message) {
  if (message[contextSequenceSource]) return message[contextSequenceSource];
  if (typeof message.seqNo === "number") return "transport";
  return "original";
}

export function normalizeRealtimeMessage(raw) {
  const message = raw && typeof raw === "object" ? raw : {};
  const payload = getRecord(message.payload);
  return {
    ...message,
    ...(payload || {}),
    [contextSequenceSource]: contextTransportSequenceDomain(message),
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
