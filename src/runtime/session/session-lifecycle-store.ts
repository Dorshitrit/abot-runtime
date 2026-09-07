import type { SessionStore } from "../ports.js";
import type { SessionDeletionListener } from "./session-deletion-cleanup.js";
import { createSessionDeletionBoundary } from "./session-deletion-boundary.js";
import type { SessionDeletionFinalizer } from "./session-deletion-finalization.js";
import { createSessionMutationQueue } from "./session-mutation-queue.js";
export type { SessionDeletionListener } from "./session-deletion-cleanup.js";

export class SessionDeletedError extends Error {
  readonly code = "session_deleted";

  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} has been deleted`);
    this.name = "SessionDeletedError";
  }
}

export function isSessionDeletedError(
  error: unknown,
): error is SessionDeletedError {
  return error instanceof SessionDeletedError;
}

export type SessionLifecycleStore = Readonly<{
  store: SessionStore;
  isDeleted: (sessionId: string) => boolean;
  onDeleted: (listener: SessionDeletionListener) => () => void;
}>;

/**
 * Environment-owned deletion boundary. Every caller must use the wrapped store:
 * an in-flight write finishes before deletion, while queued and later writes fail.
 * Tombstones last for this application lifetime; deleted IDs cannot be reused.
 */
export function createSessionLifecycleStore(
  base: SessionStore,
  finalizeDeletion?: SessionDeletionFinalizer,
): SessionLifecycleStore {
  const enqueueSessionMutation = createSessionMutationQueue();
  const deletion = createSessionDeletionBoundary(
    base,
    enqueueSessionMutation,
    finalizeDeletion,
  );

  function assertSessionNotDeleted(sessionId: string): void {
    if (deletion.isDeleted(sessionId)) {
      throw new SessionDeletedError(sessionId);
    }
  }

  function wrapSessionMutation<Args extends [string, ...unknown[]], Result>(
    operation: (...args: Args) => Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    return async (...args) => {
      assertSessionNotDeleted(args[0]);
      return enqueueSessionMutation(args[0], async () => {
        assertSessionNotDeleted(args[0]);
        return operation.apply(base, args);
      });
    };
  }

  const store: SessionStore = {
    getAllSessions: base.getAllSessions.bind(base),
    listSessions: base.listSessions.bind(base),
    getSessionById: base.getSessionById.bind(base),
    getSessionSnapshot: base.getSessionSnapshot.bind(base),
    getRequestReplayById: base.getRequestReplayById.bind(base),
    getOrCreateSession: wrapSessionMutation(base.getOrCreateSession),
    updateSessionTitle: wrapSessionMutation(base.updateSessionTitle),
    appendMessage: wrapSessionMutation(base.appendMessage),
    startRequestStream: wrapSessionMutation(base.startRequestStream),
    appendRequestEvent: wrapSessionMutation(base.appendRequestEvent),
    compareAndSwapSessionMemoryCheckpoint: wrapSessionMutation(
      base.compareAndSwapSessionMemoryCheckpoint,
    ),
    resetSession: wrapSessionMutation(base.resetSession),
    clearSessionMessages: wrapSessionMutation(base.clearSessionMessages),
    deleteMessage: wrapSessionMutation(base.deleteMessage),
    deleteMessageWithStats: wrapSessionMutation(base.deleteMessageWithStats),
    deleteSession: async (sessionId) =>
      (await deletion.deleteSessionWithStats(sessionId)).deleted,
    deleteSessionWithStats: deletion.deleteSessionWithStats,
    ...(base.updateSessionRuntimeMode
      ? {
          updateSessionRuntimeMode: wrapSessionMutation(
            base.updateSessionRuntimeMode,
          ),
        }
      : {}),
    ...(base.appendContextEntry
      ? { appendContextEntry: wrapSessionMutation(base.appendContextEntry) }
      : {}),
    ...(base.upsertArtifactPaths
      ? { upsertArtifactPaths: wrapSessionMutation(base.upsertArtifactPaths) }
      : {}),
  };

  return {
    store,
    isDeleted: deletion.isDeleted,
    onDeleted: deletion.onDeleted,
  };
}
