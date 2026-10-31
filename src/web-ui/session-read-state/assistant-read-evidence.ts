import { isSparkAssistantMessage } from "../app/lib/spark-message-visibility.js";
import type { SessionMessageIdentity } from "../../sessions/snapshot.js";
import type { SessionSnapshot } from "../../sessions/types.js";
import { isSparkSession } from "../../sessions/spark-session.js";
import { assistantReadCursorIndex } from "./projection.js";
import type { WebReadState } from "./store.js";
import { visibleMessageReceiptIdentity } from "./visible-messages.js";

export type AssistantMessageReadEvidence = {
  messageId: string;
  createdAt: number;
  requestId: string | null;
  readAt: number | null;
};

export type AssistantReadEvidence =
  | { status: "available"; messages: AssistantMessageReadEvidence[] }
  | { status: "unavailable" };

function assistantIdentity(message: SessionMessageIdentity, readAt: number | null): AssistantMessageReadEvidence {
  return { messageId: String(message.id), createdAt: message.createdAt, requestId: message.requestId, readAt };
}

function cumulativeAssistantReadEvidence(state: WebReadState, sessionId: string, messages: SessionMessageIdentity[]): AssistantMessageReadEvidence[] {
  const cursor = new Map(state.cursors).get(sessionId);
  const boundary = assistantReadCursorIndex(messages, cursor);
  const hasAssistantReadBoundary = messages[boundary]?.role === "assistant";
  return messages.flatMap((message, index) => {
    if (message.role !== "assistant") return [];
    if (!hasAssistantReadBoundary) return [assistantIdentity(message, null)];
    if (index > boundary) return [assistantIdentity(message, null)];
    return [assistantIdentity(message, cursor!.lastReadAt)];
  });
}

function visibleAssistantReadEvidence(state: WebReadState, sessionId: string, messages: SessionMessageIdentity[]): AssistantMessageReadEvidence[] {
  const saved = new Map(state.visibleMessages ?? []).get(sessionId);
  const receipts = new Set((saved?.messages ?? []).map((message) =>
    visibleMessageReceiptIdentity(message.messageId, message.createdAt, message.requestId)));
  return messages.filter(isSparkAssistantMessage).map((message) => {
    const identity = visibleMessageReceiptIdentity(message.id, message.createdAt, message.requestId);
    if (!receipts.has(identity)) return assistantIdentity(message, null);
    return assistantIdentity(message, saved!.revision);
  });
}

/** Explicit Web UI read receipts only; migration baselines are not evidence of viewing. */
export function projectAssistantReadEvidence(
  state: WebReadState,
  snapshot: Pick<SessionSnapshot, "sessionId" | "kind" | "messageIndex" | "messages">,
): Extract<AssistantReadEvidence, { status: "available" }> {
  const messages = snapshot.messageIndex ?? snapshot.messages;
  if (isSparkSession(snapshot))
    return { status: "available", messages: visibleAssistantReadEvidence(state, snapshot.sessionId, messages) };
  return { status: "available", messages: cumulativeAssistantReadEvidence(state, snapshot.sessionId, messages) };
}
