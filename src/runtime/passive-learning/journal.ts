import type { LearningBatch, PassiveLearningPreferences } from "./contracts.js";
import type { ObservationMemoryReceipt } from "../long-term-memory/observation-contracts.js";
import { resolveReviewedBatchStatus } from "./batch-receipt.js";
import { createLearningStateStore, pruneLearningBatches } from "./store.js";
import {
  isPendingLearningBatch,
  learningBatchExpiresAt,
} from "./batch-lifecycle.js";

/** Bounded intake/debug journal; canonical learned records belong to long-term memory. */
export class LearningJournal {
  private readonly store;
  private committedPreferences: PassiveLearningPreferences | undefined;
  private history: readonly LearningBatch[] = [];
  observationReviewPass: readonly string[] | undefined;
  private writes: Promise<void> = Promise.resolve();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 5_000;
  private running = false;
  storageAvailable = true;

  constructor(
    private readonly options: Readonly<{
      directory: string;
      now(): number;
      preferences(): PassiveLearningPreferences;
      changed(): void;
      failed(error: unknown): void;
      receipt?(batchId: string): Promise<ObservationMemoryReceipt | undefined>;
    }>,
  ) {
    this.store = createLearningStateStore(options.directory);
  }

  get items(): readonly LearningBatch[] {
    // Read projections must not cancel the pending disk-retention cleanup.
    return pruneLearningBatches(this.history, this.options.now());
  }

  async load(generation?: string): Promise<PassiveLearningPreferences> {
    const saved = await this.store.read();
    this.observationReviewPass = saved.observationReviewPass;
    this.committedPreferences = saved.preferences;
    this.history = await Promise.all(
      pruneLearningBatches(saved.batches, this.options.now()).map(
        async (batch): Promise<LearningBatch> => {
          if (!isPendingLearningBatch(batch)) return { ...batch, reviewProgress: undefined };
          const receipt = saved.preferences.processingPaused
            ? undefined
            : await this.options.receipt?.(batch.id);
          if (receipt)
            return {
              ...batch,
              reviewProgress: undefined,
              status: resolveReviewedBatchStatus(receipt.recordIds, receipt.candidateIds ?? []),
              reason: undefined,
              recordIds: receipt.recordIds,
              candidateIds: receipt.candidateIds ?? [],
              completedAt: receipt.createdAt,
            };
          return {
            ...batch,
            generation: generation ?? batch.generation,
            status: "pending",
            reason: "learning_stopped",
            completedAt: undefined,
          };
        },
      ),
    );
    if (saved.batches.length) await this.persist(saved.preferences);
    return saved.preferences;
  }

  async start(): Promise<void> {
    this.running = true;
    const previousCount = this.history.length;
    this.prune();
    if (this.history.length !== previousCount) await this.persist();
    if (!this.storageAvailable) this.retryPersistence();
  }
  stop(): void {
    this.running = false;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.clearPersistenceRetry();
  }

  replace(batch: LearningBatch): Promise<void> {
    return this.replaceMany([batch]);
  }

  async replaceMany(batches: readonly LearningBatch[]): Promise<void> {
    const history = new Map(this.history.map((batch) => [batch.id, batch]));
    for (const batch of batches) history.set(batch.id, {
      ...batch, reviewProgress: isPendingLearningBatch(batch) ? batch.reviewProgress : undefined,
    });
    let next = [...history.values()];
    const writesReviewProgress = batches.some((batch) => batch.reviewProgress !== undefined);
    if (writesReviewProgress) {
      const now = this.options.now();
      const writesExpiredProgress = batches.some((batch) => batch.reviewProgress !== undefined && now >= learningBatchExpiresAt(batch));
      if (writesExpiredProgress) throw new Error("learning_batch_expired");
      const eligible = next.filter((batch) => now < learningBatchExpiresAt(batch));
      const pending = eligible.filter(isPendingLearningBatch);
      next = [...pruneLearningBatches([...eligible.filter((batch) => !isPendingLearningBatch(batch)), ...pending], now)];
      const retained = new Set(next.map(({ id }) => id));
      if (pending.some(({ id }) => !retained.has(id))) throw new Error("learning_review_progress_capacity");
    }
    this.history = next;
    await this.persist();
    this.options.changed();
  }

  async partition(parts: readonly LearningBatch[]): Promise<boolean> {
    const now = this.options.now();
    const history = new Map(this.items.map((batch) => [batch.id, batch]));
    for (const part of parts) history.set(part.id, part);
    const eligible = [...history.values()].filter((batch) => now < learningBatchExpiresAt(batch));
    const pending = eligible.filter(isPendingLearningBatch);
    const terminal = eligible.filter((batch) => !isPendingLearningBatch(batch));
    const retained = pruneLearningBatches([...terminal, ...pending], now);
    const retainedIds = new Set(retained.map(({ id }) => id));
    // A split may evict terminal history, but never pending work or another active batch.
    if (pending.some(({ id }) => !retainedIds.has(id))) return false;
    this.history = retained;
    await this.persist();
    this.options.changed();
    return true;
  }

  async clearPending(): Promise<void> {
    this.observationReviewPass = undefined;
    this.history = this.history.filter(
      (batch) =>
        !isPendingLearningBatch(batch) &&
        batch.reason !== "learning_pending_deleted",
    );
    await this.persist();
  }

  persist(preferences?: PassiveLearningPreferences): Promise<void> {
    this.prune();
    const batches = this.history;
    const observationReviewPass = this.observationReviewPass;
    const write = this.writes.then(async () => {
      const nextPreferences =
        preferences ?? this.committedPreferences ?? this.options.preferences();
      try {
        await this.store.write({
          schemaVersion: 1,
          preferences: nextPreferences,
          batches,
          ...(observationReviewPass ? { observationReviewPass } : {}),
        });
        this.committedPreferences = nextPreferences;
        this.storageAvailable = true;
        this.clearPersistenceRetry();
        this.retryDelay = 5_000;
      } catch {
        this.storageAvailable = false;
        this.retryPersistence();
        throw new Error("learning_storage_unavailable");
      }
    });
    this.writes = write.catch(() => {});
    return write;
  }

  private clearPersistenceRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  async setObservationReviewPass(keys: readonly string[]): Promise<void> {
    this.observationReviewPass = Object.freeze([...keys]);
    await this.persist();
  }

  private retryPersistence(): void {
    if (!this.running || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.persist().then(this.options.changed).catch(this.options.failed);
    }, this.retryDelay);
    this.retryDelay = Math.min(60_000, this.retryDelay * 2);
    this.retryTimer.unref?.();
  }

  private prune(): void {
    this.history = pruneLearningBatches(this.history, this.options.now());
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (!this.running || !this.history.length) return;
    const expiresAt = Math.min(...this.history.map(learningBatchExpiresAt));
    const delay = Math.max(1, expiresAt - this.options.now());
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      void this.persist().then(this.options.changed).catch(this.options.failed);
    }, delay);
    this.expiryTimer.unref?.();
  }
}
