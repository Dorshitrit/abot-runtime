import type { SessionSnapshotMessage } from "../../sessions/types.js";
import type { WebReadState } from "./store.js";
import { randomUUID } from "node:crypto";

export type VisibleMessageReceipt = { messageId: string; createdAt: number; requestId: string | null };
export type VisibleMessageReadState = {
  generation: string;
  revision: number;
  messages: VisibleMessageReceipt[];
};

export function isVisibleMessageReadState(value: unknown): value is VisibleMessageReadState {
  if (!value || typeof value !== "object") return false;
  const state = value as VisibleMessageReadState;
  if (typeof state.generation !== "string" || !state.generation) return false;
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) return false;
  if (!Array.isArray(state.messages)) return false;
  return state.messages.every((message) =>
    typeof message?.messageId === "string" && Number.isFinite(message.createdAt)
      && (message.requestId === null || typeof message.requestId === "string"));
}

export function readVisibleMessageReceipts(value: unknown): WebReadState["visibleMessages"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Invalid visible message receipts.");
  for (const entry of value) {
    if (!isVisibleReceiptEntry(entry)) throw new Error("Invalid visible message receipts.");
  }
  return value;
}

function isVisibleReceiptEntry(entry: unknown): entry is [string, VisibleMessageReadState] {
  if (!Array.isArray(entry) || entry.length !== 2) return false;
  if (typeof entry[0] !== "string") return false;
  return isVisibleMessageReadState(entry[1]);
}

function ensureVisibleReadState(state: WebReadState, sessionId: string): VisibleMessageReadState {
  const stored = new Map(state.visibleMessages ?? []);
  const previous = stored.get(sessionId);
  if (previous) return previous;
  const initial = { generation: randomUUID(), revision: 0, messages: [] };
  stored.set(sessionId, initial);
  state.visibleMessages = [...stored];
  return initial;
}

function receiptIdentity(messageId: string | number, createdAt: number, requestId: string | null): string {
  return JSON.stringify([String(messageId), createdAt, requestId || null]);
}

export function visibleReadMessageIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 500)
    throw new Error("visible_message_ids_invalid");
  return [...new Set(input.map((id) => {
    if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) return String(id);
    if (typeof id === "string" && id.length > 0 && id.length <= 256) return id;
    throw new Error("visible_message_ids_invalid");
  }))];
}

export function visibleReadObservations(ids: readonly string[], input: unknown): VisibleMessageReceipt[] {
  if (!Array.isArray(input) || input.length !== ids.length) throw new Error("visible_message_receipts_invalid");
  const observations = input.map((entry): VisibleMessageReceipt => {
    if (!entry || typeof entry !== "object") throw new Error("visible_message_receipts_invalid");
    const id = visibleReadMessageIds([entry.id])[0]!;
    if (!ids.includes(id)) throw new Error("visible_message_receipts_invalid");
    if (!Number.isFinite(entry.createdAt)) throw new Error("visible_message_receipts_invalid");
    const requestId = entry.requestId;
    if (requestId !== null && typeof requestId !== "string") throw new Error("visible_message_receipts_invalid");
    return { messageId: id, createdAt: entry.createdAt, requestId: requestId || null };
  });
  if (new Set(observations.map((receipt) => receipt.messageId)).size !== ids.length)
    throw new Error("visible_message_receipts_invalid");
  return observations;
}

export function markVisibleAssistantMessages(
  state: WebReadState, sessionId: string, messages: SessionSnapshotMessage[], observations: readonly VisibleMessageReceipt[], generation: unknown, now: number,
): void {
  const previous = ensureVisibleReadState(state, sessionId);
  if (generation !== previous.generation) throw new Error("read_generation_changed");
  const stored = new Map(state.visibleMessages ?? []);
  const assistants = messages.filter((message) => message.role === "assistant");
  const canonical = new Set(assistants.map((message) => receiptIdentity(message.id, message.createdAt, message.requestId)));
  const requested = new Set(observations.map((receipt) => receiptIdentity(receipt.messageId, receipt.createdAt, receipt.requestId)));
  for (const identity of requested) {
    if (!canonical.has(identity)) throw new Error("visible_message_receipt_stale");
  }
  const prior = new Set(previous.messages.map((receipt) => receiptIdentity(receipt.messageId, receipt.createdAt, receipt.requestId)));
  const receipts = messages.filter((message) => message.role === "assistant").filter((message) => {
    const identity = receiptIdentity(message.id, message.createdAt, message.requestId);
    if (requested.has(identity)) return true;
    return prior.has(identity);
  }).map((message) => ({ messageId: String(message.id), createdAt: message.createdAt, requestId: message.requestId }));
  if (JSON.stringify(receipts) === JSON.stringify(previous?.messages ?? [])) return;
  stored.set(sessionId, { generation: previous.generation, revision: Math.max(now, previous.revision + 1), messages: receipts });
  state.visibleMessages = [...stored];
}

export function projectVisibleSessionReadState(
  state: WebReadState, sessionId: string, messages: SessionSnapshotMessage[],
) {
  const saved = ensureVisibleReadState(state, sessionId);
  const assistants = messages.filter((message) => message.role === "assistant");
  const identities = new Set(saved.messages.map((receipt) => receiptIdentity(receipt.messageId, receipt.createdAt, receipt.requestId)));
  const wasRead = (message: SessionSnapshotMessage) => identities.has(receiptIdentity(message.id, message.createdAt, message.requestId));
  const unread = assistants.filter((message) => !wasRead(message));
  const lastRead = [...assistants].reverse().find(wasRead);
  return {
    sessionId, readStateStatus: "available" as const,
    unreadMessageIds: unread.map((message) => message.id),
    unreadCount: unread.length, hasUnread: unread.length > 0,
    readRevision: saved?.revision ?? 0,
    readGeneration: saved.generation,
    lastReadAt: saved?.revision ?? state.initializedAt,
    lastReadMessageId: lastRead?.id ?? null,
    latestMessageId: messages.at(-1)?.id ?? null,
    latestAssistantMessageId: assistants.at(-1)?.id ?? null,
  };
}
