import type { SessionSnapshotMessage } from "../../sessions/types.js";
import type { WebReadCursor, WebReadState } from "./store.js";

export type ReadBoundary = {
  readThroughMessageId?: unknown;
  readThroughRequestId?: unknown;
};

function messageTimestamp(message: SessionSnapshotMessage): number {
  const value =
    typeof message.createdAt === "number"
      ? message.createdAt
      : Date.parse(String(message.createdAt));
  return Number.isFinite(value) ? value : 0;
}

function cursorIndex(
  messages: SessionSnapshotMessage[],
  cursor?: WebReadCursor,
): number {
  if (!cursor) return -1;
  if (!cursor.messageId) return -1;
  return messages.findIndex(
    (message) =>
      String(message.id) === cursor.messageId &&
      messageTimestamp(message) === cursor.createdAt,
  );
}

function requestedAssistantIndex(
  messages: SessionSnapshotMessage[],
  boundary: ReadBoundary,
): number {
  const id = boundary.readThroughMessageId;
  const hasNumericBoundary =
    typeof id === "number" && Number.isSafeInteger(id) && id >= 0;
  if (hasNumericBoundary)
    return messages.findIndex(
      (message) =>
        message.role === "assistant" && String(message.id) === String(id),
    );
  const requestId = boundary.readThroughRequestId;
  if (typeof requestId !== "string" || !requestId) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.requestId === requestId)
      return index;
  }
  return -1;
}

export function advanceReadCursor(
  state: WebReadState,
  sessionId: string,
  messages: SessionSnapshotMessage[],
  boundary: ReadBoundary,
  now: number,
): void {
  const nextIndex = requestedAssistantIndex(messages, boundary);
  if (nextIndex < 0) return;
  const cursors = new Map(state.cursors);
  const previous = cursors.get(sessionId);
  const previousIndex = cursorIndex(messages, previous);
  if (previousIndex >= nextIndex) return;
  const message = messages[nextIndex]!;
  const createdAt = messageTimestamp(message);
  if (previous && previous.createdAt > createdAt) return;
  cursors.set(sessionId, {
    messageId: String(message.id),
    createdAt,
    lastReadAt: Math.max(
      now,
      (previous?.lastReadAt ?? state.initializedAt) + 1,
    ),
  });
  state.cursors = [...cursors];
}

export function projectSessionReadState(
  state: WebReadState,
  sessionId: string,
  messages: SessionSnapshotMessage[],
) {
  const cursor = new Map(state.cursors).get(sessionId);
  const readIndex = cursorIndex(messages, cursor);
  const unreadCount = messages.filter((message, index) => {
    if (message.role !== "assistant") return false;
    if (messageTimestamp(message) <= state.initializedAt) return false;
    return index > readIndex;
  }).length;
  return {
    sessionId,
    readStateStatus: "available" as const,
    unreadCount,
    hasUnread: unreadCount > 0,
    lastReadMessageId: cursor?.messageId || null,
    lastReadAt: cursor?.lastReadAt ?? state.initializedAt,
    latestMessageId: messages.at(-1)?.id ?? null,
    latestAssistantMessageId:
      [...messages].reverse().find((message) => message.role === "assistant")
        ?.id ?? null,
  };
}
