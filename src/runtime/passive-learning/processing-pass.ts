import type { LearningObservation, LearningBatch, PassiveLearningPreferences } from "./contracts.js";
import type { LearningActiveBatches } from "./active-batches.js";
import type { LearningJournal } from "./journal.js";
import { hasObservationStoragePressure, type ObservationQueue } from "./queue.js";
import { canProcessLearningObservation } from "./application-policy.js";
import { isPendingLearningBatch } from "./batch-lifecycle.js";
import { hasLearningTriggerWork, isObservationTriggered } from "./processing-trigger.js";
import { traceDebug } from "../observability/debug-logger.js";

type PassOptions = Readonly<{
  queue: ObservationQueue;
  journal: LearningJournal;
  active: LearningActiveBatches;
  preferences(): PassiveLearningPreferences;
  generation(): string;
  now(): number;
}>;

/** A bounded snapshot of work admitted together; fresh intake belongs to the next pass. */
export class LearningProcessingPass {
  constructor(private readonly options: PassOptions) {}

  hasReadyWork(): boolean {
    const pending = this.pendingObservations();
    if (this.hasUnfinishedPass()) return pending.some((item) => this.isAdmitted(item));
    return this.canStartPass(pending);
  }

  remaining(): number {
    if (!isObservationTriggered(this.options.preferences())) return 0;
    return this.pendingObservations().filter((item) => this.isAdmitted(item)).length;
  }

  async admit(): Promise<void> {
    const preferences = this.options.preferences();
    if (!isObservationTriggered(preferences)) return;
    if (this.hasUnfinishedPass()) return;
    const pending = this.pendingObservations();
    if (!this.canStartPass(pending)) return;
    await this.options.journal.setObservationReviewPass(pending.map(observationReviewKey));
    traceDebug("runtime.passive_learning", "processing.pass_admitted", {
      observations: pending.length, threshold: preferences.analysisObservationCount,
      trigger: hasLearningTriggerWork(preferences, pending.length) ? "count" : "storage_pressure",
    });
  }

  allows(item: LearningObservation): boolean {
    const preferences = this.options.preferences();
    if (!canProcessLearningObservation(item, preferences)) return false;
    if (!isObservationTriggered(preferences)) return true;
    return this.isAdmitted(item);
  }

  private isAdmitted(item: LearningObservation): boolean {
    return this.options.journal.observationReviewPass?.includes(observationReviewKey(item)) ?? false;
  }

  private canStartPass(pending: readonly LearningObservation[]): boolean {
    if (!pending.length) return false;
    const preferences = this.options.preferences();
    if (hasLearningTriggerWork(preferences, pending.length)) return true;
    if (!isObservationTriggered(preferences)) return false;
    if (hasObservationStoragePressure(pending)) return true;
    // Blocked intake shares queue capacity, but only eligible queued work is at risk.
    const queued = this.options.queue.items;
    if (!queued.some((item) => canProcessLearningObservation(item, preferences))) return false;
    return hasObservationStoragePressure(queued);
  }

  private hasUnfinishedPass(): boolean {
    if (!isObservationTriggered(this.options.preferences())) return false;
    return this.pendingObservations(true).some((item) => this.isAdmitted(item));
  }

  private pendingObservations(includeActive = false): readonly LearningObservation[] {
    const options = this.options;
    options.queue.expire(options.now());
    const batches = options.journal.items.filter((batch) => this.isPendingBatch(batch, includeActive));
    return [...options.queue.items, ...batches.flatMap((batch) => batch.observations)]
      .filter((item) => canProcessLearningObservation(item, options.preferences()));
  }

  private isPendingBatch(batch: LearningBatch, includeActive: boolean): boolean {
    if (batch.generation !== this.options.generation()) return false;
    if (!isPendingLearningBatch(batch)) return false;
    if (includeActive) return true;
    return !this.options.active.has(batch.id);
  }
}

function observationReviewKey(item: LearningObservation): string {
  return JSON.stringify([item.deviceId, item.id]);
}

/** Optional metadata for old state files; no screen text or new activity history. */
export function readObservationReviewPass(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 2048) throw new Error("invalid_learning_state");
  if (!value.every(isBoundedObservationKey)) throw new Error("invalid_learning_state");
  return Object.freeze([...new Set(value as string[])]);
}

function isBoundedObservationKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.length > 0 && value.length <= 1024;
}
