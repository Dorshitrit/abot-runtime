export type SessionDeletionListener = (
  sessionId: string,
) => void | Promise<void>;

interface SessionDeletionState {
  pending: Set<SessionDeletionListener>;
  attempt?: Promise<void>;
}

/** Tombstones and original cleanup obligations last for this environment lifetime. */
export function createSessionDeletionCleanup() {
  const listeners = new Set<SessionDeletionListener>();
  const deletedSessions = new Map<string, SessionDeletionState>();

  function deletionState(sessionId: string): SessionDeletionState {
    const existing = deletedSessions.get(sessionId);
    if (existing) return existing;
    const state = { pending: new Set(listeners) };
    deletedSessions.set(sessionId, state);
    return state;
  }

  return {
    isDeleted: (sessionId: string) => deletedSessions.has(sessionId),
    onDeleted: (listener: SessionDeletionListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify: (sessionId: string): Promise<void> => {
      // Install the tombstone before invoking any listener or yielding.
      const state = deletionState(sessionId);
      if (state.attempt) return state.attempt;
      if (state.pending.size === 0) return Promise.resolve();
      return startCleanupAttempt(sessionId, state);
    },
  };
}

function startCleanupAttempt(
  sessionId: string,
  state: SessionDeletionState,
): Promise<void> {
  let resolveAttempt!: () => void;
  let rejectAttempt!: (error: unknown) => void;
  const attempt = new Promise<void>((resolve, reject) => {
    resolveAttempt = resolve;
    rejectAttempt = reject;
  });
  // Reentrant or concurrent deletion sees this same attempt immediately.
  state.attempt = attempt;
  void settleCleanupListeners(sessionId, state).then(
    () => {
      state.attempt = undefined;
      resolveAttempt();
    },
    (error: unknown) => {
      state.attempt = undefined;
      rejectAttempt(error);
    },
  );
  return attempt;
}

async function settleCleanupListeners(
  sessionId: string,
  state: SessionDeletionState,
): Promise<void> {
  const outcomes = await Promise.allSettled(
    [...state.pending].map(async (listener) => {
      await listener(sessionId);
      state.pending.delete(listener);
    }),
  );
  // Keep only failed obligations, and wait for every listener before a retry.
  const failure = outcomes.find(isFailedCleanup);
  if (failure) throw failure.reason;
}

function isFailedCleanup(
  outcome: PromiseSettledResult<void>,
): outcome is PromiseRejectedResult {
  return outcome.status === "rejected";
}
