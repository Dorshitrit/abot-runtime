import type { SessionDeleteResult } from "../../sessions/types.js";
import type { SessionStore } from "../ports.js";

/** Accessed only inside the owning lifecycle's per-session mutation queue. */
export function createSessionDeletionReceipts(
  base: Pick<SessionStore, "deleteSessionWithStats">,
) {
  const undelivered = new Map<string, SessionDeleteResult>();

  return {
    async remove(sessionId: string): Promise<SessionDeleteResult> {
      const existing = undelivered.get(sessionId);
      if (existing) return existing;

      // Keep exact physical counts when later lifecycle cleanup rejects.
      const receipt = { ...(await base.deleteSessionWithStats(sessionId)) };
      undelivered.set(sessionId, receipt);
      return receipt;
    },
    acknowledge(sessionId: string): void {
      undelivered.delete(sessionId);
    },
  };
}
