import { createSessionComposerQueue, type SessionComposerQueueScope, type SessionComposerQueueItemInput } from "../app/lib/session-composer-queue.js";
import { ClientStateError, type ClientState } from "./contracts.js";

function queueScope(input: unknown): SessionComposerQueueScope {
  if (!input || typeof input !== "object") throw new ClientStateError("invalid_queue_scope", "A conversation is required.");
  const scope = input as SessionComposerQueueScope;
  for (const value of [scope.environmentId, scope.sessionId]) {
    if (typeof value !== "string" || !value.trim())
      throw new ClientStateError("invalid_queue_scope", "Invalid conversation identity.");
  }
  return { environmentId: scope.environmentId, sessionId: scope.sessionId };
}

/** Runs within the store transaction: a queue item can be released by only one caller. */
export function changeClientQueue(state: ClientState, input: Record<string, unknown>): unknown {
  const scope = queueScope(input.scope);
  const ownerId = typeof input.ownerId === "string" && input.ownerId.length <= 128 ? input.ownerId : null;
  const requiresRecoveryOwner = ["claim", "begin", "uncertain"].includes(String(input.action));
  if (requiresRecoveryOwner && !ownerId)
    throw new ClientStateError("invalid_queue_owner", "A window identity is required to recover a queued message.");
  const queue = createSessionComposerQueue({ ownerId, storage: {
    getItem: () => state.queue || null,
    setItem: (_key, value) => { state.queue = value; },
  } });
  const token = typeof input.releaseToken === "string" ? input.releaseToken : "";
  const requestId = typeof input.requestId === "string" ? input.requestId : "";
  if (input.action === "claim") return queue.claimBlockedRelease(scope, token, { takeover: input.takeover === true });
  if (input.action === "begin") return queue.beginBlockedSend(scope, token);
  if (input.action === "uncertain") return queue.markBlockedUncertain(scope, token);
  if (input.action === "enqueue") return queue.enqueue(scope, input.item as SessionComposerQueueItemInput);
  if (input.action === "release") return queue.releaseForTerminal(scope, requestId);
  if (input.action === "bind") return queue.bindReleasedSuccess(scope, token, requestId);
  if (input.action === "rebind") return queue.rebindBlocked(scope, requestId);
  if (input.action === "update") return queue.updateBlockedRelease(scope, token, input.item as SessionComposerQueueItemInput);
  throw new ClientStateError("invalid_queue_action", "Unknown message queue operation.");
}
