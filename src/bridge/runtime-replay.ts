import type WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  clearSessionMessages,
  deleteMessageWithStats,
  deleteSessionWithStats,
  getRequestReplayById,
  getSessionSnapshot,
  listSessions,
} from "../sessions/index.js";
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  type RuntimeAttachmentStore,
} from "../runtime/attachments/store.js";
import type { SessionStore } from "../runtime/ports.js";
import {
  deleteSessionWithAttachments,
  deleteSessionAttachmentsIfSupported,
} from "../runtime/session/session-attachment-deletion.js";
import { resolveRuntimeAttachmentMimeType } from "../shared/attachments.js";

type JsonObject = Record<string, unknown>;
type RuntimeReplaySessionStore = Pick<
  SessionStore,
  | "clearSessionMessages"
  | "deleteMessageWithStats"
  | "deleteSessionWithStats"
  | "getRequestReplayById"
  | "getSessionSnapshot"
  | "listSessions"
>;

const defaultRuntimeReplaySessionStore: RuntimeReplaySessionStore = {
  clearSessionMessages,
  deleteMessageWithStats,
  deleteSessionWithStats,
  getRequestReplayById,
  getSessionSnapshot,
  listSessions,
};

function getString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function getNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function messageSequence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const prefixed = /^msg-(\d+)$/u.exec(value);
  if (prefixed) {
    return Number(prefixed[1]);
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isSameMessageId(
  snapshotMessageId: unknown,
  requestedId: string,
): boolean {
  if (String(snapshotMessageId) === requestedId) {
    return true;
  }
  const snapshotSequence = messageSequence(snapshotMessageId);
  const requestedSequence = messageSequence(requestedId);
  return (
    snapshotSequence !== null &&
    requestedSequence !== null &&
    snapshotSequence === requestedSequence
  );
}

function getOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function getOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function getAttachmentStorageRef(attachment: unknown): string {
  if (
    !attachment ||
    typeof attachment !== "object" ||
    Array.isArray(attachment)
  ) {
    return "";
  }
  return getString((attachment as JsonObject).storageRef);
}

function collectMessageAttachmentStorageRefs(messages: unknown): Set<string> {
  const refs = new Set<string>();
  if (!Array.isArray(messages)) {
    return refs;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const attachments = (message as JsonObject).attachments;
    if (!Array.isArray(attachments)) {
      continue;
    }
    for (const attachment of attachments) {
      const storageRef = getAttachmentStorageRef(attachment);
      if (storageRef) {
        refs.add(storageRef);
      }
    }
  }
  return refs;
}

const SAFE_ATTACHMENT_OWNER_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;
const MAX_ATTACHMENT_UPLOAD_BASE64_CHARS =
  Math.ceil(DEFAULT_MAX_ATTACHMENT_BYTES / 3) * 4;

function createBridgeAttachmentUploadRequestId(): string {
  return `bridge-upload-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function isSafeAttachmentOwnerSegment(value: string): boolean {
  return SAFE_ATTACHMENT_OWNER_SEGMENT_PATTERN.test(value);
}

function sendRuntimeReplayResponse(ws: WebSocket, payload: JsonObject): void {
  ws.send(JSON.stringify(payload));
}

function sendFailure(
  ws: WebSocket,
  type: string,
  correlationId: string,
  extra: JsonObject,
  error: string,
): void {
  sendRuntimeReplayResponse(ws, {
    type,
    correlationId,
    ok: false,
    ...extra,
    error,
  });
}

export async function handleRuntimeReplayBridgeMessage(
  ws: WebSocket,
  msg: JsonObject,
  options: {
    sessionStore?: RuntimeReplaySessionStore;
    attachmentStore?: RuntimeAttachmentStore;
  } = {},
): Promise<boolean> {
  const sessionStore = options.sessionStore ?? defaultRuntimeReplaySessionStore;
  const type = getString(msg.type);
  switch (type) {
    case "request.events.request":
      await handleRequestEventsRequest(ws, msg, sessionStore);
      return true;
    case "session.list.request":
      await handleSessionListRequest(ws, msg, sessionStore);
      return true;
    case "session.snapshot.request":
      await handleSessionSnapshotRequest(ws, msg, sessionStore);
      return true;
    case "session.delete.request":
      await handleSessionDeleteRequest(
        ws,
        msg,
        sessionStore,
        options.attachmentStore,
      );
      return true;
    case "session.messages.clear.request":
      await handleSessionMessagesClearRequest(
        ws,
        msg,
        sessionStore,
        options.attachmentStore,
      );
      return true;
    case "session.message.delete.request":
      await handleSessionMessageDeleteRequest(
        ws,
        msg,
        sessionStore,
        options.attachmentStore,
      );
      return true;
    case "attachment.upload.request":
      await handleAttachmentUploadRequest(ws, msg, options.attachmentStore);
      return true;
    case "attachment.fetch.request":
      await handleAttachmentFetchRequest(ws, msg, options.attachmentStore);
      return true;
    default:
      return false;
  }
}

async function handleAttachmentFetchRequest(
  ws: WebSocket,
  msg: JsonObject,
  attachmentStore: RuntimeAttachmentStore | undefined,
): Promise<void> {
  const correlationId = getString(msg.correlationId);
  const sessionId = getString(msg.sessionId);
  const attachmentValue = msg.attachment;

  if (!correlationId || !sessionId) {
    sendFailure(
      ws,
      "attachment.fetch.response",
      correlationId,
      { sessionId, attachment: null },
      !correlationId ? "correlationId required" : "sessionId required",
    );
    return;
  }
  if (!attachmentStore) {
    sendFailure(
      ws,
      "attachment.fetch.response",
      correlationId,
      { sessionId, attachment: null },
      "attachment_store_unavailable",
    );
    return;
  }
  if (
    !attachmentValue ||
    typeof attachmentValue !== "object" ||
    Array.isArray(attachmentValue)
  ) {
    sendFailure(
      ws,
      "attachment.fetch.response",
      correlationId,
      { sessionId, attachment: null },
      "attachment_must_be_object",
    );
    return;
  }

  const attachmentRecord = attachmentValue as JsonObject;
  const name = getOptionalString(attachmentRecord.name);
  const size = getOptionalNumber(attachmentRecord.size);
  const mimeType = getString(attachmentRecord.mimeType);
  const supported = resolveRuntimeAttachmentMimeType(mimeType);
  const declaredKind = getOptionalString(attachmentRecord.kind);
  const kind = declaredKind ?? supported?.kind;
  const attachment = {
    id: getString(attachmentRecord.id),
    kind,
    mimeType,
    storageRef: getString(attachmentRecord.storageRef),
    ...(name ? { name } : {}),
    ...(size !== undefined ? { size } : {}),
  };

  try {
    if (kind !== "image" && kind !== "file") {
      throw new Error("attachment_kind_unsupported");
    }
    const [validated] = await attachmentStore.validateAttachmentReferences(
      [{ ...attachment, kind }],
      { sessionId },
    );
    if (!validated) {
      throw new Error("attachment_reference_invalid");
    }
    const resolved = await attachmentStore.resolveAttachment(validated);
    const data = await readFile(resolved.absolutePath, "base64");
    sendRuntimeReplayResponse(ws, {
      type: "attachment.fetch.response",
      correlationId,
      ok: true,
      sessionId,
      attachment: resolved.metadata,
      data,
    });
  } catch (error) {
    sendFailure(
      ws,
      "attachment.fetch.response",
      correlationId,
      { sessionId, attachment: null },
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleAttachmentUploadRequest(
  ws: WebSocket,
  msg: JsonObject,
  attachmentStore: RuntimeAttachmentStore | undefined,
): Promise<void> {
  const correlationId = getString(msg.correlationId);
  const sessionId = getString(msg.sessionId);
  const rawRequestId = getString(msg.requestId);
  const requestId = isSafeAttachmentOwnerSegment(rawRequestId)
    ? rawRequestId
    : createBridgeAttachmentUploadRequestId();
  const mimeType = getString(msg.mimeType);
  const declaredKind = getOptionalString(msg.kind);
  const name = getOptionalString(msg.name);
  const data = getString(msg.data);

  if (!correlationId || !sessionId || !mimeType || !data) {
    sendFailure(
      ws,
      "attachment.upload.response",
      correlationId,
      { sessionId, attachment: null },
      !correlationId
        ? "correlationId required"
        : !sessionId
          ? "sessionId required"
          : !mimeType
            ? "mimeType required"
            : "data required",
    );
    return;
  }
  if (!attachmentStore) {
    sendFailure(
      ws,
      "attachment.upload.response",
      correlationId,
      { sessionId, attachment: null },
      "attachment_store_unavailable",
    );
    return;
  }
  const supported = resolveRuntimeAttachmentMimeType(mimeType);
  if (!supported || (declaredKind && declaredKind !== supported.kind)) {
    sendFailure(
      ws,
      "attachment.upload.response",
      correlationId,
      { sessionId, attachment: null },
      "attachment_type_unsupported",
    );
    return;
  }
  if (data.length > MAX_ATTACHMENT_UPLOAD_BASE64_CHARS) {
    sendFailure(
      ws,
      "attachment.upload.response",
      correlationId,
      { sessionId, attachment: null },
      "attachment_size_exceeded",
    );
    return;
  }

  try {
    const attachment = await attachmentStore.saveAttachment({
      sessionId,
      requestId,
      kind: supported.kind,
      mimeType,
      bytes: Buffer.from(data, "base64"),
      ...(name ? { name } : {}),
    });
    sendRuntimeReplayResponse(ws, {
      type: "attachment.upload.response",
      correlationId,
      ok: true,
      sessionId,
      attachment,
    });
  } catch (error) {
    sendFailure(
      ws,
      "attachment.upload.response",
      correlationId,
      { sessionId, attachment: null },
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleRequestEventsRequest(
  ws: WebSocket,
  msg: JsonObject,
  sessionStore: RuntimeReplaySessionStore,
): Promise<void> {
  const correlationId = getString(msg.correlationId);
  const requestId = getString(msg.requestId);
  const afterSeq = getNumber(msg.afterSeq);

  if (!correlationId || !requestId) {
    sendFailure(
      ws,
      "request.events.response",
      correlationId,
      { requestId, events: [], finalState: null },
      !correlationId ? "correlationId required" : "requestId required",
    );
    return;
  }

  try {
    const replay = await sessionStore.getRequestReplayById(requestId, afterSeq);
    if (!replay) {
      sendFailure(
        ws,
        "request.events.response",
        correlationId,
        { requestId, events: [], finalState: null },
        "request events not found",
      );
      return;
    }

    sendRuntimeReplayResponse(ws, {
      type: "request.events.response",
      correlationId,
      ok: true,
      requestId,
      events: replay.events,
      finalState: replay.finalState,
    });
  } catch (error) {
    sendRuntimeReplayResponse(ws, {
      type: "request.events.response",
      correlationId,
      ok: false,
      requestId,
      events: [],
      finalState: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleSessionListRequest(
  ws: WebSocket,
  msg: JsonObject,
  sessionStore: RuntimeReplaySessionStore,
): Promise<void> {
  const correlationId = getString(msg.correlationId);
  if (!correlationId) {
    sendFailure(
      ws,
      "session.list.response",
      correlationId,
      { sessions: [], nextCursor: null },
      "correlationId required",
    );
    return;
  }

  try {
    const result = await sessionStore.listSessions({
      limit: typeof msg.limit === "number" ? msg.limit : undefined,
      cursor: getOptionalString(msg.cursor),
    });
    sendRuntimeReplayResponse(ws, {
      type: "session.list.response",
      correlationId,
      ok: true,
      sessions: result.sessions,
      nextCursor: result.nextCursor,
    });
  } catch (error) {
    sendFailure(
      ws,
      "session.list.response",
      correlationId,
      { sessions: [], nextCursor: null },
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleSessionSnapshotRequest(
  ws: WebSocket,
  msg: JsonObject,
  sessionStore: RuntimeReplaySessionStore,
): Promise<void> {
  const correlationId = getString(msg.correlationId);
  const sessionId = getString(msg.sessionId);
  if (!correlationId || !sessionId) {
    sendFailure(
      ws,
      "session.snapshot.response",
      correlationId,
      { sessionId, messages: [], requests: [], nextCursor: null },
      !correlationId ? "correlationId required" : "sessionId required",
    );
    return;
  }

  try {
    const snapshot = await sessionStore.getSessionSnapshot(sessionId, {
      afterMessageId:
        typeof msg.afterMessageId === "string" ||
        typeof msg.afterMessageId === "number"
          ? msg.afterMessageId
          : null,
      includeRequests: getOptionalBoolean(msg.includeRequests),
    });
    if (!snapshot) {
      sendFailure(
        ws,
        "session.snapshot.response",
        correlationId,
        { sessionId, messages: [], requests: [], nextCursor: null },
        "session_not_found",
      );
      return;
    }
    sendRuntimeReplayResponse(ws, {
      type: "session.snapshot.response",
      correlationId,
      ok: true,
      sessionId,
      messages: snapshot.messages,
      requests: snapshot.requests,
      nextCursor: snapshot.nextCursor,
    });
  } catch (error) {
    sendFailure(
      ws,
      "session.snapshot.response",
      correlationId,
      { sessionId, messages: [], requests: [], nextCursor: null },
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleSessionDeleteRequest(
  ws: WebSocket,
  msg: JsonObject,
  sessionStore: RuntimeReplaySessionStore,
  attachmentStore: RuntimeAttachmentStore | undefined,
): Promise<void> {
  const correlationId = getString(msg.correlationId);
  const sessionId = getString(msg.sessionId);
  if (!correlationId || !sessionId) {
    sendFailure(
      ws,
      "session.delete.response",
      correlationId,
      { sessionId, deleted: false, deletedMessages: 0, deletedRequests: 0 },
      !correlationId ? "correlationId required" : "sessionId required",
    );
    return;
  }

  try {
    const result = await deleteSessionWithAttachments(
      sessionStore,
      attachmentStore,
      sessionId,
    );
    sendRuntimeReplayResponse(ws, {
      type: "session.delete.response",
      correlationId,
      ok: true,
      ...result,
    });
  } catch (error) {
    sendFailure(
      ws,
      "session.delete.response",
      correlationId,
      { sessionId, deleted: false, deletedMessages: 0, deletedRequests: 0 },
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleSessionMessagesClearRequest(
  ws: WebSocket,
  msg: JsonObject,
  sessionStore: RuntimeReplaySessionStore,
  attachmentStore: RuntimeAttachmentStore | undefined,
): Promise<void> {
  const correlationId = getString(msg.correlationId);
  const sessionId = getString(msg.sessionId);
  if (!correlationId || !sessionId) {
    sendFailure(
      ws,
      "session.messages.clear.response",
      correlationId,
      {
        sessionId,
        cleared: false,
        deletedMessages: 0,
        deletedRequests: 0,
        updatedAt: Date.now(),
      },
      !correlationId ? "correlationId required" : "sessionId required",
    );
    return;
  }

  try {
    const result = await sessionStore.clearSessionMessages(sessionId);
    if (!result) {
      sendFailure(
        ws,
        "session.messages.clear.response",
        correlationId,
        {
          sessionId,
          cleared: false,
          deletedMessages: 0,
          deletedRequests: 0,
          updatedAt: Date.now(),
        },
        "session_not_found",
      );
      return;
    }
    await deleteSessionAttachmentsIfSupported(attachmentStore, sessionId);
    sendRuntimeReplayResponse(ws, {
      type: "session.messages.clear.response",
      correlationId,
      ok: true,
      ...result,
    });
  } catch (error) {
    sendFailure(
      ws,
      "session.messages.clear.response",
      correlationId,
      {
        sessionId,
        cleared: false,
        deletedMessages: 0,
        deletedRequests: 0,
        updatedAt: Date.now(),
      },
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function deleteAttachmentIfSupported(
  attachmentStore: RuntimeAttachmentStore | undefined,
  attachment: unknown,
  sessionId: string,
): Promise<void> {
  if (!attachmentStore?.deleteAttachment) {
    return;
  }
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
    return;
  }
  const attachmentObject = attachment as JsonObject;
  const name = getOptionalString(attachmentObject.name);
  const size = getOptionalNumber(attachmentObject.size);
  try {
    await attachmentStore.deleteAttachment(
      {
        id: getString(attachmentObject.id),
        kind: "image",
        mimeType: getString(attachmentObject.mimeType),
        storageRef: getString(attachmentObject.storageRef),
        ...(name ? { name } : {}),
        ...(size !== undefined ? { size } : {}),
      },
      { sessionId },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "attachment_owner_invalid"
    ) {
      return;
    }
    throw error;
  }
}

async function handleSessionMessageDeleteRequest(
  ws: WebSocket,
  msg: JsonObject,
  sessionStore: RuntimeReplaySessionStore,
  attachmentStore: RuntimeAttachmentStore | undefined,
): Promise<void> {
  const correlationId = getString(msg.correlationId);
  const sessionId = getString(msg.sessionId);
  const messageId =
    typeof msg.messageId === "number"
      ? String(msg.messageId)
      : getString(msg.messageId);
  if (!correlationId || !sessionId || !messageId) {
    sendFailure(
      ws,
      "session.message.delete.response",
      correlationId,
      { sessionId, messageId, deleted: false, updatedAt: Date.now() },
      !correlationId
        ? "correlationId required"
        : !sessionId
          ? "sessionId required"
          : "messageId required",
    );
    return;
  }

  try {
    const snapshot = await sessionStore.getSessionSnapshot(sessionId, {
      includeRequests: false,
    });
    const targetMessage = snapshot?.messages.find(
      (message) => isSameMessageId(message.id, messageId),
    );
    const attachments = Array.isArray(targetMessage?.attachments)
      ? targetMessage.attachments
      : [];
    const result = await sessionStore.deleteMessageWithStats(
      sessionId,
      messageId,
    );
    if (!result) {
      sendFailure(
        ws,
        "session.message.delete.response",
        correlationId,
        { sessionId, messageId, deleted: false, updatedAt: Date.now() },
        "session_not_found",
      );
      return;
    }
    if (result.deleted && attachments.length > 0) {
      const updatedSnapshot = await sessionStore.getSessionSnapshot(sessionId, {
        includeRequests: false,
      });
      const remainingAttachmentRefs = collectMessageAttachmentStorageRefs(
        updatedSnapshot?.messages,
      );
      await Promise.all(
        attachments
          .filter((attachment) => {
            const storageRef = getAttachmentStorageRef(attachment);
            return storageRef && !remainingAttachmentRefs.has(storageRef);
          })
          .map((attachment) =>
            deleteAttachmentIfSupported(attachmentStore, attachment, sessionId),
          ),
      );
    }
    sendRuntimeReplayResponse(ws, {
      type: "session.message.delete.response",
      correlationId,
      ok: true,
      ...result,
    });
  } catch (error) {
    sendFailure(
      ws,
      "session.message.delete.response",
      correlationId,
      { sessionId, messageId, deleted: false, updatedAt: Date.now() },
      error instanceof Error ? error.message : String(error),
    );
  }
}
