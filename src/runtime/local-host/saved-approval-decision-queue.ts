import { createSessionMutationQueue } from "../session/session-mutation-queue.js";

/** Permission commands reread canonical receipts after earlier decisions settle. */
export function createSavedApprovalDecisionQueue() {
  const enqueue = createSessionMutationQueue();
  return <T>(sessionId: string, requestId: string, decide: () => Promise<T>): Promise<T> =>
    enqueue(JSON.stringify([sessionId, requestId]), decide);
}
