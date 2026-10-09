import { hasAutomationSessionOrigin } from "../automation-session-origin.js";
import {
  clientVisibleMessages,
  toEpochMs,
  toMessageIdForUi,
  toSessionListItem,
} from "../record/projection.js";
import type { SessionListItem, SessionRecord, SessionSnapshotMessage } from "../types.js";

export type SessionMessageMetadata = Pick<SessionSnapshotMessage, "id" | "role" | "createdAt">;

/** Derived data only. User read cursors stay in the Web UI's existing store. */
export type SessionMetadata = {
  version: 1;
  source: string;
  interactive: boolean;
  updatedAt: string;
  summary: SessionListItem;
  messages: SessionMessageMetadata[];
};

export function projectSessionMetadata(session: SessionRecord, source: string): SessionMetadata {
  return {
    version: 1,
    source,
    interactive: !hasAutomationSessionOrigin(session),
    updatedAt: session.updatedAt,
    summary: toSessionListItem(session),
    messages: clientVisibleMessages(session.messages).map((message) => ({
      id: toMessageIdForUi(message.id),
      role: message.role,
      createdAt: toEpochMs(message.createdAt),
    })),
  };
}

function isMessageMetadata(value: SessionMessageMetadata): boolean {
  if (!value) return false;
  if (typeof value.id !== "string" && typeof value.id !== "number") return false;
  if (value.role !== "user" && value.role !== "assistant") return false;
  return Number.isFinite(value.createdAt);
}

export function isCurrentSessionMetadata(
  value: unknown, sessionId: string, source: string,
): value is SessionMetadata {
  if (!value || typeof value !== "object") return false;
  const record = value as SessionMetadata;
  if (record.version !== 1) return false;
  if (record.source !== source) return false;
  if (typeof record.interactive !== "boolean") return false;
  if (typeof record.updatedAt !== "string") return false;
  if (record.summary?.id !== sessionId) return false;
  if (typeof record.summary.title !== "string") return false;
  if (typeof record.summary.lastMessagePreview !== "string") return false;
  if (!Number.isFinite(record.summary.createdAt)) return false;
  if (!Number.isFinite(record.summary.updatedAt)) return false;
  if (!Array.isArray(record.messages)) return false;
  return record.messages.every(isMessageMetadata);
}

/** Stable ordering is owned here so future paging need not change callers' storage knowledge. */
export function compareSessionMetadata(left: SessionMetadata, right: SessionMetadata): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.summary.id.localeCompare(right.summary.id);
}
