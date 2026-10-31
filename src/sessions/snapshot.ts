import type { SessionRecord, SessionSnapshot, SessionSnapshotMessage, SessionRequestRecord } from "./types.js";
import { clientVisibleMessages, filterMessagesAfter, createMessageRequestIdResolver, toEpochMs, toMessageIdForUi, toSnapshotMessage, toSnapshotRequest } from "./record/projection.js";

export type SessionMessageIdentity = Pick<SessionSnapshotMessage, "id" | "role" | "createdAt" | "requestId" | "kind">;
export type SessionSnapshotOptions = {
  afterMessageId?: string | number | null;
  includeRequests?: boolean;
  /** Web read receipts need identities, never message bodies or request events. */
  identitiesOnly?: boolean;
  page?: { limit: number; cursor?: string | null; targetMessageId?: string; targetCreatedAt?: number; targetRequestId?: string; waitingRequestId?: string };
};

type Anchor = { sessionId: string; id: string; createdAt: string; direction: "older" | "newer" };

function encodeAnchor(sessionId: string, message: SessionRecord["messages"][number], direction: Anchor["direction"]): string {
  return Buffer.from(JSON.stringify({ sessionId, id: message.id, createdAt: message.createdAt, direction })).toString("base64url");
}

function decodeAnchor(cursor: string, sessionId: string): Anchor {
  try {
    const anchor = JSON.parse(Buffer.from(cursor, "base64url").toString()) as Anchor;
    if (anchor.sessionId !== sessionId) throw new Error();
    if (typeof anchor.id !== "string" || typeof anchor.createdAt !== "string") throw new Error();
    if (!["older", "newer"].includes(anchor.direction)) throw new Error();
    return anchor;
  } catch { throw new Error("history_cursor_stale"); }
}

function messageWindow(sessionId: string, messages: SessionRecord["messages"], page: NonNullable<SessionSnapshotOptions["page"]>, resolveRequestId: ReturnType<typeof createMessageRequestIdResolver>) {
  const limit = page.limit;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("history_page_size_invalid");
  let start = Math.max(0, messages.length - limit);
  let end = messages.length;
  if (page.targetMessageId != null) {
    const target = messages.findIndex((message) => {
      if (String(toMessageIdForUi(message.id)) !== page.targetMessageId) return false;
      if (page.targetCreatedAt == null) return true;
      if (toEpochMs(message.createdAt) !== page.targetCreatedAt) return false;
      return (resolveRequestId(message) || "") === (page.targetRequestId || "");
    });
    if (target >= 0) { start = target; end = Math.min(messages.length, start + limit); }
  } else if (page.targetRequestId) {
    const target = messages.findIndex((message) => resolveRequestId(message) === page.targetRequestId);
    if (target >= 0) { start = target; end = Math.min(messages.length, start + limit); }
  }
  if (page.cursor) {
    const anchor = decodeAnchor(page.cursor, sessionId);
    const index = messages.findIndex((message) => message.id === anchor.id && message.createdAt === anchor.createdAt);
    if (index < 0) throw new Error("history_cursor_stale");
    start = anchor.direction === "older" ? Math.max(0, index - limit) : index + 1;
    end = anchor.direction === "older" ? index : Math.min(messages.length, start + limit);
  }
  const selected = messages.slice(start, end);
  return {
    selected,
    nextCursor: start > 0 && selected.length ? encodeAnchor(sessionId, selected[0]!, "older") : null,
    newerCursor: end < messages.length && selected.length ? encodeAnchor(sessionId, selected.at(-1)!, "newer") : null,
  };
}

function isRequiredPageRequest(request: SessionRequestRecord, ids: Set<string | null>, waitingRequestId?: string, continuation = false): boolean {
  if (ids.has(request.requestId)) return true;
  if (continuation) return false;
  if (request.requestId === waitingRequestId) return true;
  if (request.status === "streaming") return true;
  return request.status === "awaiting_approval";
}

export function projectSessionSnapshot(session: SessionRecord, options: SessionSnapshotOptions = {}): SessionSnapshot {
  const visible = clientVisibleMessages(session.messages);
  const requests = session.requests ?? [];
  const resolveRequestId = createMessageRequestIdResolver(requests);
  const base = {
    sessionId: session.id, title: session.title,
    ...(session.kind ? { kind: session.kind } : {}),
    ...(session.project ? { project: session.project } : {}),
  };
  // The default projection is kept intact for existing session consumers.
  if (!options.page && !options.identitiesOnly) return {
    ...base,
    messages: filterMessagesAfter(visible, options.afterMessageId).map((message) => toSnapshotMessage(session.id, message, requests, resolveRequestId)),
    requests: options.includeRequests === false ? [] : requests.map(toSnapshotRequest),
    nextCursor: null,
  };
  const messageIndex: SessionMessageIdentity[] = visible.map((message) => ({
    ...(message.kind ? { kind: message.kind } : {}),
    id: toMessageIdForUi(message.id), role: message.role, createdAt: toEpochMs(message.createdAt),
    requestId: resolveRequestId(message),
  }));
  if (options.identitiesOnly) return { ...base, messages: [], requests: [], nextCursor: null, messageIndex };
  const page = messageWindow(session.id, visible, options.page!, resolveRequestId);
  const messages = page.selected.map((message) => toSnapshotMessage(session.id, message, requests, resolveRequestId));
  const ids = new Set(messages.map((message) => message.requestId));
  return {
    ...base, messages, messageIndex, nextCursor: page.nextCursor, newerCursor: page.newerCursor,
    requests: options.includeRequests === false ? [] : requests
      .filter((request) => isRequiredPageRequest(request, ids, options.page?.waitingRequestId, Boolean(options.page?.cursor))).map(toSnapshotRequest),
  };
}
