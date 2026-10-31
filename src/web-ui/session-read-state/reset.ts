import { randomUUID } from "node:crypto";
import type { RuntimeSessionsResetResult } from "../../runtime/local-host/maintenance-contracts.js";
import type { WebReadState, WebReadStateStore } from "./store.js";

export function resetSessionReadState(state: WebReadState, sessionId: string, now: number): void {
  const cursors = new Map(state.cursors);
  const previous = cursors.get(sessionId);
  cursors.set(sessionId, { messageId: "", createdAt: 0,
    lastReadAt: Math.max(now, (previous?.lastReadAt ?? state.initializedAt) + 1) });
  state.cursors = [...cursors];
  const visible = new Map(state.visibleMessages ?? []);
  const prior = visible.get(sessionId);
  visible.set(sessionId, { generation: randomUUID(), revision: Math.max(now, (prior?.revision ?? 0) + 1), messages: [] });
  state.visibleMessages = [...visible];
}

/** Hold receipt writes across the owner reset so new reads cannot be erased afterward. */
export function resetConversationReadStates(store: WebReadStateStore,
  operation: () => Promise<RuntimeSessionsResetResult>, now: () => number): Promise<RuntimeSessionsResetResult> {
  return store.transaction(async state => {
    const result = await operation();
    const deleted = new Set(result.deletedSessionIds);
    state.cursors = state.cursors.filter(([id]) => !deleted.has(id));
    state.visibleMessages = state.visibleMessages?.filter(([id]) => !deleted.has(id));
    for (const id of result.clearedSessionIds) resetSessionReadState(state, id, now());
    return result;
  });
}
