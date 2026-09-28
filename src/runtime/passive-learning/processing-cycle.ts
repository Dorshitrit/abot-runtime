import { isWithinAnalysisWindow } from "./analysis-schedule.js";
import type { LearningAnalysisClock } from "./analysis-clock.js";
import type { LearningActiveBatches } from "./active-batches.js";
import type { LearningBackgroundDependencies } from "./background-dependencies.js";
import { createPendingLearningBatch, isDeferredLearningFailure } from "./batch-lifecycle.js";
import type { LearningBatch, PassiveLearningPreferences } from "./contracts.js";
import type { LearningJournal } from "./journal.js";
import type { ObservationQueue } from "./queue.js";
import { availableLearningBatchSlots, isLearningDailyBudgetFailure, learningBudgetDeferral, learningBatchEmbeddingCalls, type LearningBudgetDeferral } from "./processing-budget-policy.js";
import type { CoWorkerResourceUsage } from "./resources/contracts.js";
import { canProcessLearningBatch } from "./application-policy.js";
import { prepareApplicationPendingBatch } from "./application-pending.js";
import { reconcileLearningBatchReceipts } from "./batch-receipt.js";
import { isObservationTriggered } from "./processing-trigger.js";
import { LearningProcessingPass } from "./processing-pass.js";
import { hasLearningProcessingConfigurationChanged } from "./control-policy.js";

/** One admitted processing cycle; async quota checks cannot duplicate dequeues. */
export class LearningProcessingCycle {
  deferral: LearningBudgetDeferral | undefined;
  private running: Promise<void> | undefined;
  private lastUsage: CoWorkerResourceUsage | undefined;
  private readonly pass: LearningProcessingPass;
  constructor(private readonly options: Readonly<{
    background: LearningBackgroundDependencies;
    queue: ObservationQueue;
    journal: LearningJournal;
    active: LearningActiveBatches;
    clock: LearningAnalysisClock;
    preferences(): PassiveLearningPreferences;
    canReconcileReceipts(): boolean;
    canProcess(): boolean;
    generation(): string;
    now(): number;
    intervalMs(): number;
    concurrency(): number;
    dispatch(batch: LearningBatch): void;
    arm(): void;
    deferred(): void;
  }>) { this.pass = new LearningProcessingPass(options); }
  flush(): Promise<void> {
    this.running ??= this.run().finally(() => { this.running = undefined; });
    return this.running;
  }
  async reconcile(): Promise<void> {
    if (!this.options.canReconcileReceipts()) return;
    await reconcileLearningBatchReceipts({ ...this.options, memory: this.options.background.memory });
  }
  hasReadyWork(): boolean {
    return this.pass.hasReadyWork();
  }
  remainingPass(): number { return this.pass.remaining(); }
  preferencesChanged(previous: PassiveLearningPreferences, next: PassiveLearningPreferences, availabilityValidated = false): void {
    if (availabilityValidated || hasLearningProcessingConfigurationChanged(previous, next)) this.deferral = undefined;
  }
  delayMs(): number {
    if (isObservationTriggered(this.options.preferences())) return 0;
    return this.options.intervalMs();
  }
  noteFailure(error: unknown): boolean {
    if (!isDeferredLearningFailure(error)) return false;
    const budgetStatus = error.message === "learning_receipt_capacity" || isLearningDailyBudgetFailure(error);
    const until = this.deferredFailureRetryAt(error);
    if (this.deferral && this.deferral.until >= until) return budgetStatus;
    this.deferral = { until, reason: error.message };
    this.options.clock.clear();
    return budgetStatus;
  }
  private deferredFailureRetryAt(error: Error): number {
    const now = this.options.now();
    const retryAt = now + this.options.intervalMs();
    if (!isLearningDailyBudgetFailure(error)) return retryAt;
    if (!this.lastUsage || now >= this.lastUsage.resetsAt) return retryAt;
    return this.lastUsage.resetsAt;
  }
  private isProcessingAllowed(): boolean {
    if (!this.options.canProcess()) return false;
    if (this.deferral && this.options.now() < this.deferral.until) return false;
    return isWithinAnalysisWindow(this.options.now(), this.options.preferences().analysisWindow);
  }
  private async run(): Promise<void> {
    const options = this.options;
    const cycleStartedAt = options.now();
    await this.reconcile();
    if (!this.hasReadyWork()) { options.clock.clear(isObservationTriggered(options.preferences())); return; }
    if (!this.isProcessingAllowed()) { options.arm(); return; }
    const usage = options.background.resourceUsage ? await options.background.resourceUsage() : undefined;
    this.lastUsage = usage;
    if (!this.isProcessingAllowed()) { options.arm(); return; }
    const preferences = options.preferences();
    const embeddingCallsPerBatch = learningBatchEmbeddingCalls(options.background);
    this.deferral = learningBudgetDeferral(usage, preferences, embeddingCallsPerBatch);
    options.clock.clear();
    if (this.deferral) { options.deferred(); options.arm(); return; }
    const admission = options.background.memory.learning?.reviewAdmission
      ? await options.background.memory.learning.reviewAdmission() : undefined;
    if (admission && !admission.available) {
      this.deferral = { until: admission.retryAt ? Date.parse(admission.retryAt) : Number.POSITIVE_INFINITY,
        reason: "learning_receipt_capacity" };
      options.deferred(); options.arm(); return;
    }
    if (!this.isProcessingAllowed()) { options.arm(); return; }
    const slots = availableLearningBatchSlots(usage, preferences, options.concurrency() - options.active.size, embeddingCallsPerBatch);
    if (!slots) {
      options.clock.dispatched(options.now(), options.intervalMs());
      options.arm();
      return;
    }
    await this.pass.admit();
    let dispatched = false;
    for (let remaining = slots; remaining > 0; remaining -= 1) {
      if (!this.isProcessingAllowed()) break;
      if (!this.hasReadyWork()) break;
      let pending: LearningBatch | undefined;
      try {
        pending = await prepareApplicationPendingBatch({ ...options, memory: options.background.memory,
          eligible: (item) => this.pass.allows(item) });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "learning_partition_capacity") throw error;
        this.deferral = { until: options.now() + options.intervalMs(), reason: error.message };
        options.deferred(); options.arm(); return;
      }
      if (!this.isProcessingAllowed()) break;
      if (!this.hasReadyWork()) break;
      if (pending && pending.generation !== options.generation()) break;
      if (pending && !canProcessLearningBatch(pending, options.preferences())) break;
      const observations = pending?.observations ?? options.queue.take(options.now(),
        (item) => this.pass.allows(item));
      if (!observations.length) break;
      options.dispatch(pending ?? createPendingLearningBatch(observations, options.generation(), options.now()));
      dispatched = true;
    }
    if (dispatched) options.clock.dispatched(cycleStartedAt, this.delayMs());
    options.arm();
    await options.active.settle();
  }
}
