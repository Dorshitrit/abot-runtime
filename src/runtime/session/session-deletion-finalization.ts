import type { SessionDeleteResult } from "../../sessions/types.js";

export type SessionDeletionFinalizer = (
  result: SessionDeleteResult,
) => void | Promise<void>;

/** Cleanup captures its physical-result promise before another call can replace it. */
export function createSessionDeletionFinalization(
  finalize: SessionDeletionFinalizer,
) {
  const physicalResults = new Map<string, Promise<SessionDeleteResult>>();

  return {
    prepare(sessionId: string) {
      let resolve!: (result: SessionDeleteResult) => void;
      let reject!: (error: unknown) => void;
      const physical = new Promise<SessionDeleteResult>((onResult, onError) => {
        resolve = onResult;
        reject = onError;
      });
      // Concurrent callers share cleanup, so some prepared results have no listener.
      void physical.catch(() => undefined);
      physicalResults.set(sessionId, physical);
      return (outcome: PromiseSettledResult<SessionDeleteResult>) => {
        if (outcome.status === "fulfilled") resolve(outcome.value);
        else reject(outcome.reason);
        if (physicalResults.get(sessionId) === physical)
          physicalResults.delete(sessionId);
      };
    },
    async finalizeDeletedSession(sessionId: string): Promise<void> {
      const physical = physicalResults.get(sessionId);
      if (!physical) throw new Error("session_deletion_attempt_missing");
      const result = await physical;
      if (!result.deleted) return;
      await finalize(result);
    },
  };
}
