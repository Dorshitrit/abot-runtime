import type { LongTermMemoryRepository } from "../contracts.js";
import { traceDebug } from "../../observability/debug-logger.js";
import { LearningMaintenanceClock } from "./maintenance-clock.js";
import { maintainLearningMemory, nextLearningExpiryAt } from "./maintenance.js";
import { learningMaturationPolicy } from "./policy.js";

export type MemoryRetentionLifecycle = Readonly<{
  start(): Promise<void>;
  stop(): Promise<void>;
  reason(): string | undefined;
  subscribeChanges(listener: () => void): () => void;
}>;

/** Core storage retention remains active independently of collection and inference. */
export function createMemoryRetentionLifecycle(options: {
  repository: LongTermMemoryRepository;
  subscribeCommits(listener: (policyChanged: boolean) => void): () => void;
  now?: () => Date;
}): MemoryRetentionLifecycle {
  const now = () => (options.now?.() ?? new Date()).getTime();
  const listeners = new Set<() => void>();
  let reason: string | undefined;
  let unsubscribe: (() => void) | undefined;
  const setReason = (next: string | undefined) => {
    if (reason === next) return;
    reason = next;
    for (const listener of listeners) {
      try { listener(); } catch { /* Status consumers do not own retention. */ }
    }
  };
  const clock = new LearningMaintenanceClock({
    now,
    policy: async () => learningMaturationPolicy(await options.repository.read()),
    memory: {
      nextExpiryAt: async (policy) => nextLearningExpiryAt(await options.repository.read(), policy),
      maintenance: (policy) => maintainLearningMemory(options.repository, policy, now()),
    },
    refreshed: () => setReason(undefined),
    failed: () => {
      setReason("learning_maintenance_failed");
      traceDebug("runtime.long_term_memory", "maintenance.failed", { reason: "learning_maintenance_failed" });
    },
  });
  const lifecycle: MemoryRetentionLifecycle = Object.freeze({
    start() {
      unsubscribe ??= options.subscribeCommits((policyChanged) => {
        void (policyChanged ? clock.preferencesChanged() : clock.knowledgeChanged());
      });
      return clock.start();
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      await clock.stop();
    },
    reason: () => reason,
    subscribeChanges(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
  // Existing standalone service callers already own a live service; no opt-in is required.
  void lifecycle.start();
  return lifecycle;
}
