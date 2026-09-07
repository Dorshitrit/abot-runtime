import { assertValidSessionId } from "../../sessions/record/rules.js";
import type { SessionDeleteResult } from "../../sessions/types.js";
import type { SessionStore } from "../ports.js";
import { createSessionDeletionCleanup } from "./session-deletion-cleanup.js";
import {
  createSessionDeletionFinalization,
  type SessionDeletionFinalizer,
} from "./session-deletion-finalization.js";
import { createSessionDeletionReceipts } from "./session-deletion-receipts.js";
import type { SessionMutationQueue } from "./session-mutation-queue.js";

/** Shared transaction for managed stores and compatibility deletion adapters. */
export function createSessionDeletionBoundary(
  base: Pick<SessionStore, "deleteSessionWithStats">,
  enqueue: SessionMutationQueue,
  finalize?: SessionDeletionFinalizer,
) {
  const cleanup = createSessionDeletionCleanup();
  const receipts = createSessionDeletionReceipts(base);
  const finalization = finalize
    ? createSessionDeletionFinalization(finalize)
    : undefined;
  if (finalization) cleanup.onDeleted(finalization.finalizeDeletedSession);

  async function deleteSessionWithStats(
    sessionId: string,
  ): Promise<SessionDeleteResult> {
    assertValidSessionId(sessionId);
    const settlePhysical = finalization?.prepare(sessionId);
    let notification!: Promise<PromiseSettledResult<void>[]>;
    // Reserve before invoking listeners: synchronous reentry must queue behind us.
    const result = enqueue(sessionId, async () => {
      const [deletion] = await Promise.allSettled([receipts.remove(sessionId)]);
      settlePhysical?.(deletion);
      const [notified] = await notification;
      if (deletion.status === "rejected") throw deletion.reason;
      if (notified.status === "rejected") throw notified.reason;
      receipts.acknowledge(sessionId);
      return deletion.value;
    });
    // The queue is deferred; intent and cleanup are still installed synchronously.
    notification = Promise.allSettled([cleanup.notify(sessionId)]);
    return result;
  }

  return {
    deleteSessionWithStats,
    isDeleted: cleanup.isDeleted,
    onDeleted: cleanup.onDeleted,
  };
}
