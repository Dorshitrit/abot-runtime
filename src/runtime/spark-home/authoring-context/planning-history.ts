import { AUTHORING_CONTEXT_LIMITS as limits } from "./contracts.js";
import type { CapturedHistoryRecords } from "./history-records.js";
import { boundEntries, clippedText } from "./projection.js";

export function projectPlanningHistory(captured: CapturedHistoryRecords, requestId: string) {
  const entries = captured.snapshots.map(snapshot => {
    const eligible = snapshot.messages.filter(message => message.requestId !== requestId && !message.kind);
    const newest = [...eligible].reverse();
    const message = newest.find(entry => entry.role === "user") ?? newest[0];
    return {
      sessionId: snapshot.sessionId, title: clippedText(snapshot.title, 120), authority: "prior_conversation_not_current_intent",
      latestLoadedMessage: message ? {
        id: message.id, requestId: message.requestId, role: message.role, source: message.source,
        createdAt: message.createdAt, text: clippedText(message.text, 350),
      } : null,
      omittedLoadedMessages: Math.max(0, eligible.length - (message ? 1 : 0)),
      excludedCurrentRequestMessages: snapshot.messages.filter(entry => entry.requestId === requestId).length,
      earlierMessagesNotLoaded: snapshot.nextCursor !== null,
    };
  });
  return { ...boundEntries(entries, limits.ordinarySessions + 1, limits.planningHistoryCharacters, {
    availableCount: entries.length, scannedCount: captured.scannedCount,
    selection: "latest_prior_user_message_per_captured_conversation_else_latest_message; significance_is_not_inferred_from_recency",
  }), moreSessionsNotLoaded: captured.moreSessionsNotLoaded };
}
