import type { SessionSnapshot } from "../../../sessions/types.js";
import { AUTHORING_CONTEXT_LIMITS as limits } from "./contracts.js";
import { boundEntries, clippedText } from "./projection.js";
import type { CapturedHistoryRecords } from "./history-records.js";

function projectHistory(snapshot: SessionSnapshot, requestId: string, budget: number) {
  const eligible = snapshot.messages.filter(message => message.requestId !== requestId && !message.kind);
  const newestFirst = [...eligible].reverse();
  const latestUser = newestFirst.find(message => message.role === "user");
  const prioritized = latestUser ? [latestUser, ...newestFirst.filter(message => message !== latestUser)] : newestFirst;
  const chronologicalPosition = new Map(eligible.map((message, index) => [message.id, index]));
  const messages = prioritized.slice(0, limits.messagesPerSession).map(message => {
    const content = clippedText(message.text, Math.min(500, budget - 200));
    return {
      id: message.id, role: message.role, createdAt: message.createdAt,
      requestId: message.requestId, text: content.text, omittedTextCharacters: content.omittedCharacters,
    };
  });
  const bounded = boundEntries(messages, limits.messagesPerSession, budget);
  return {
    sessionId: snapshot.sessionId, kind: snapshot.kind ?? "ordinary", title: clippedText(snapshot.title, 120),
    authority: "prior_conversation_not_current_intent",
    messages: [...bounded.entries].sort((left, right) => chronologicalPosition.get(left.id)! - chronologicalPosition.get(right.id)!),
    omittedLoadedMessages: eligible.length - bounded.entries.length,
    excludedCurrentRequestMessages: snapshot.messages.filter(message => message.requestId === requestId).length,
    excludedNonConversationMessages: snapshot.messages.filter(message => message.kind).length,
    earlierMessagesNotLoaded: snapshot.nextCursor !== null,
  };
}

export function projectAuthoringHistory(captured: CapturedHistoryRecords, requestId: string) {
  const entries = captured.snapshots.map((snapshot, index) => projectHistory(snapshot, requestId, index === 0 ? 1000 : 400));
  return {
    ...boundEntries(entries, limits.ordinarySessions + 1, limits.historyCharacters, {
      scannedCount: captured.scannedCount, selection: "canonical_SPARK_plus_7_recent_ordinary_sessions_in_this_environment",
    }),
    moreSessionsNotLoaded: captured.moreSessionsNotLoaded,
  };
}
