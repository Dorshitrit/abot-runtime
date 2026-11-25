import type { RuntimeSessionsResetResult } from "../../runtime/local-host/maintenance-contracts.js";
import { belongsToAgentDraft } from "../app/lib/agent-draft-scope.js";
import { AGENT_DRAFT_PREFERENCE } from "./agent-draft-preference.js";
import type { ClientState } from "./contracts.js";
import { WebClientStateStore } from "./store.js";

function removeResetConversationQueues(state: ClientState, environmentId: string, result: RuntimeSessionsResetResult): void {
  if (!state.queue) return;
  // The store has already validated this persisted queue using its owning decoder.
  const queue: { queues: Array<{ environmentId: string; sessionId: string }> } = JSON.parse(state.queue);
  const removed = new Set([...result.deletedSessionIds, ...result.clearedSessionIds]);
  queue.queues = queue.queues.filter(entry => {
    if (entry.environmentId !== environmentId) return true;
    if (result.complete) return false;
    return !removed.has(entry.sessionId);
  });
  state.queue = JSON.stringify(queue);
}

/** Delete all draft scopes for this Agent in the same transaction as other preference writers. */
export function createAgentDraftCleanup(rootDir: string) {
  const store = new WebClientStateStore(rootDir);
  return async (environmentId: string, agentId: string): Promise<void> => {
    await store.transaction(state => {
      const raw = state.preferences[AGENT_DRAFT_PREFERENCE];
      if (!raw) return;
      const drafts: Record<string, unknown> = JSON.parse(raw);
      const keys = Object.keys(drafts).filter(key => belongsToAgentDraft(key, environmentId, agentId));
      if (!keys.length) return;
      for (const key of keys) delete drafts[key];
      if (Object.keys(drafts).length) state.preferences[AGENT_DRAFT_PREFERENCE] = JSON.stringify(drafts);
      else delete state.preferences[AGENT_DRAFT_PREFERENCE];
    });
  };
}

/** Keep queued sends serialized with reset; never carry a deleted conversation's queue forward. */
export function createRuntimeSessionResetClientState(rootDir: string) {
  const store = new WebClientStateStore(rootDir);
  return async (environmentId: string, operation: () => Promise<RuntimeSessionsResetResult>) => {
    const saved = await store.transaction(async state => {
      const result = await operation();
      removeResetConversationQueues(state, environmentId, result);
      return result;
    });
    return saved.result;
  };
}
