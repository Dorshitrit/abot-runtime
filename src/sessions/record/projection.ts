import type {
  SessionMessageSource,
  SessionRecord,
  SessionRequestRecord,
  SessionRequestReplay,
  SessionRuntimeEvent,
  SessionSnapshotMessage,
  SessionSnapshotRequest,
} from "../types.js";

function getRequestEventCompactionKey(
  payload: Record<string, unknown>,
): string {
  const type = typeof payload.type === "string" ? payload.type : "";
  const name = typeof payload.name === "string" ? payload.name : "";
  if (type === "token") {
    return "token";
  }
  if (type === "event" && name === "thinking.delta") {
    return "event:thinking.delta";
  }
  return "";
}

function shouldStoreRequestEvent(payload: Record<string, unknown>): boolean {
  const type = typeof payload.type === "string" ? payload.type : "";
  const name = typeof payload.name === "string" ? payload.name : "";
  return !(type === "event" && name === "token");
}

export function compactRequestEvents(
  events: SessionRuntimeEvent[],
): SessionRuntimeEvent[] {
  const compacted: SessionRuntimeEvent[] = [];
  for (const event of events) {
    if (!shouldStoreRequestEvent(event.payload)) {
      continue;
    }
    const compactionKey = getRequestEventCompactionKey(event.payload);
    if (compactionKey) {
      const last = compacted[compacted.length - 1];
      if (
        last &&
        getRequestEventCompactionKey(last.payload) === compactionKey
      ) {
        compacted[compacted.length - 1] = event;
        continue;
      }
    }
    compacted.push(event);
  }
  return compacted;
}

export function getSessionRequest(
  session: SessionRecord,
  requestId: string,
): SessionRequestRecord | null {
  return (
    (session.requests ?? []).find(
      (request) => request.requestId === requestId,
    ) ?? null
  );
}

export function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return 100;
  }
  return Math.min(500, Math.max(1, Math.floor(limit as number)));
}

export function normalizeCursor(cursor: string | null | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number(cursor);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

export function normalizeAfterSeq(afterSeq: number): number {
  return Number.isFinite(afterSeq) ? Math.max(0, Math.floor(afterSeq)) : 0;
}

export function toEpochMs(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function toClientReplayEvent(
  event: SessionRuntimeEvent,
): Record<string, unknown> {
  return {
    ...event.payload,
    type: event.type,
    requestId: event.requestId,
    seqNo: event.seqNo,
    timestamp: toEpochMs(event.timestamp),
  };
}

export function getRequestFinalState(
  request: SessionRequestRecord,
): SessionRequestReplay["finalState"] {
  for (let index = request.events.length - 1; index >= 0; index -= 1) {
    const event = request.events[index];
    if (event.type === "completed") {
      return {
        status: "completed",
        output: event.payload.output,
        completedAt: toEpochMs(event.timestamp),
      };
    }
    if (event.type === "failed") {
      return {
        status: "failed",
        error: event.payload.error,
        completedAt: toEpochMs(event.timestamp),
      };
    }
  }
  return null;
}

function toMessageIdForUi(id: string): string | number {
  const match = /^msg-(\d+)$/.exec(id);
  if (match) {
    return Number(match[1]);
  }
  return id;
}

function messageSequence(
  value: string | number | null | undefined,
): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const prefixed = /^msg-(\d+)$/.exec(value);
  if (prefixed) {
    return Number(prefixed[1]);
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function isSameMessageId(
  messageId: string,
  requestedId: string,
): boolean {
  return (
    messageId === requestedId ||
    String(toMessageIdForUi(messageId)) === requestedId
  );
}

export function filterMessagesAfter(
  messages: SessionRecord["messages"],
  afterMessageId: string | number | null | undefined,
): SessionRecord["messages"] {
  if (afterMessageId === null || typeof afterMessageId === "undefined") {
    return messages;
  }
  const afterKey = String(afterMessageId);
  const exactIndex = messages.findIndex(
    (message) =>
      message.id === afterKey ||
      String(toMessageIdForUi(message.id)) === afterKey,
  );
  if (exactIndex >= 0) {
    return messages.slice(exactIndex + 1);
  }
  const afterSequence = messageSequence(afterMessageId);
  if (afterSequence === null) {
    return messages;
  }
  return messages.filter((message) => {
    const sequence = messageSequence(message.id);
    return sequence !== null && sequence > afterSequence;
  });
}

function isClientVisibleMessage(
  message: SessionRecord["messages"][number],
): boolean {
  return message.grounding !== "tool_observation";
}

export function clientVisibleMessages(
  messages: SessionRecord["messages"],
): SessionRecord["messages"] {
  return messages.filter(isClientVisibleMessage);
}

function messageSource(
  message: SessionRecord["messages"][number],
): SessionMessageSource {
  if (message.source) {
    return message.source;
  }
  return message.role === "user" ? "user" : "request";
}

export function toSnapshotMessage(
  sessionId: string,
  message: SessionRecord["messages"][number],
  requests: SessionRequestRecord[],
): SessionSnapshotMessage {
  return {
    id: toMessageIdForUi(message.id),
    sessionId,
    role: message.role,
    text: message.content,
    source: messageSource(message),
    createdAt: toEpochMs(message.createdAt),
    requestId: message.requestId ?? inferMessageRequestId(message, requests),
    cronJobId: message.cronJobId ?? null,
    ...(message.schedule ? { schedule: message.schedule } : {}),
    cronTitle: message.cronTitle ?? null,
    triggerType: message.triggerType ?? null,
    ...(message.attachments && message.attachments.length > 0
      ? { attachments: message.attachments }
      : {}),
  };
}

function inferMessageRequestId(
  message: SessionRecord["messages"][number],
  requests: SessionRequestRecord[],
): string | null {
  if (message.role !== "assistant") {
    return null;
  }
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    const finalState = getRequestFinalState(request);
    if (
      finalState?.status === "completed" &&
      typeof finalState.output === "string" &&
      finalState.output === message.content
    ) {
      return request.requestId;
    }
  }
  return null;
}

export function toSnapshotRequest(
  request: SessionRequestRecord,
): SessionSnapshotRequest {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    status: request.status,
    createdAt: toEpochMs(request.createdAt),
    updatedAt: toEpochMs(request.updatedAt),
    lastSeqNo: request.lastSeqNo,
    events: request.events.map(toClientReplayEvent),
    finalState: getRequestFinalState(request),
  };
}

function previewMessage(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 160);
}

export function normalizeSessionTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, 80);
}

export function toSessionListItem(session: SessionRecord) {
  const visibleMessages = clientVisibleMessages(session.messages);
  const lastMessage = visibleMessages.at(-1) ?? null;
  const latestAssistantMessage = [...visibleMessages]
    .reverse()
    .find((message) => message.role === "assistant");
  return {
    id: session.id,
    title: session.title,
    createdAt: toEpochMs(session.createdAt),
    updatedAt: toEpochMs(session.updatedAt),
    lastMessagePreview: lastMessage ? previewMessage(lastMessage.content) : "",
    lastMessageAt: lastMessage ? toEpochMs(lastMessage.createdAt) : null,
    latestMessageId: lastMessage ? toMessageIdForUi(lastMessage.id) : null,
    latestAssistantMessageId: latestAssistantMessage
      ? toMessageIdForUi(latestAssistantMessage.id)
      : null,
  };
}
