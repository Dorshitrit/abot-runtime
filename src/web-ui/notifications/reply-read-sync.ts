import type { AssistantReadEvidence } from "../session-read-state/assistant-read-evidence.js";
import type { WebNotification } from "./contracts.js";
import type { WebNotificationStore } from "./store.js";

type AssistantEvidence = Extract<AssistantReadEvidence, { status: "available" }>["messages"][number];
export type NotificationReadEvidence = (environmentId: string, sessionId: string) => Promise<AssistantReadEvidence>;

export function isReplyReadCandidate(item: WebNotification): boolean {
  if (item.kind !== "reply") return false;
  if (typeof item.requestId !== "string") return false;
  return item.requestId.length > 0;
}

function matchesSparkReplyIdentity(message: AssistantEvidence, messageId: string, createdAt: number, requestId?: string): boolean {
  if (message.messageId !== messageId) return false;
  if (message.createdAt !== createdAt) return false;
  return message.requestId === requestId;
}

function exactSparkSource(item: WebNotification, messages: AssistantEvidence[]): AssistantEvidence | undefined {
  const url = new URL(item.sourceUrl, "http://notification.local");
  const messageId = url.searchParams.get("message");
  if (!messageId) return undefined;
  const createdAt = Number(url.searchParams.get("messageCreatedAt"));
  return messages.find((message) => matchesSparkReplyIdentity(message, messageId, createdAt, item.requestId));
}

function matchingReplySource(item: WebNotification, messages: AssistantEvidence[]): AssistantEvidence | undefined {
  if (item.sessionKind === "spark") return exactSparkSource(item, messages);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.requestId !== item.requestId) continue;
    if (message.createdAt > item.createdAt) continue;
    return message;
  }
  return undefined;
}

function hasReadReplySource(item: WebNotification, messages: AssistantEvidence[]): boolean {
  const message = matchingReplySource(item, messages);
  if (!message) return false;
  return message.readAt !== null;
}

/** Reconcile only canonical assistant-message evidence, never presence or notification navigation. */
export async function synchronizeReplyNotifications(
  store: WebNotificationStore,
  environmentId: string,
  readEvidence: NotificationReadEvidence,
  sessionId?: string,
): Promise<number> {
  const candidates = (await store.getUnreadReplies(sessionId)).filter(isReplyReadCandidate);
  const grouped = new Map<string, WebNotification[]>();
  for (const item of candidates) {
    if (!item.sessionId) continue;
    const group = grouped.get(item.sessionId) ?? [];
    group.push(item);
    grouped.set(item.sessionId, group);
  }
  const ids: string[] = [];
  // The store is bounded; serialize source reads rather than fan out across every session.
  for (const [sourceSession, items] of grouped) {
    const evidence = await readEvidence(environmentId, sourceSession);
    if (evidence.status !== "available") continue;
    for (const item of items) {
      if (!hasReadReplySource(item, evidence.messages)) continue;
      ids.push(item.id);
    }
  }
  if (!ids.length) return 0;
  return (await store.markRepliesRead(ids)).updated;
}
