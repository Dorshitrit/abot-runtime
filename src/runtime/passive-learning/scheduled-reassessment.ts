import type { LearningMemoryService } from "../long-term-memory/maturation/contracts.js";
import type { LearningBackgroundContext, LearningReassessmentLifecycle } from "./background-dependencies.js";
import type { LearningReassessmentStatus, PassiveLearningModel } from "./contracts.js";
import { LearningAnalysisClock } from "./analysis-clock.js";
import { isWithinAnalysisWindow } from "./analysis-schedule.js";
import { learningBudgetDeferral, isLearningDailyBudgetFailure } from "./processing-budget-policy.js";
import type { CoWorkerResourceUsage } from "./resources/contracts.js";
import { createReassessmentStateStore, learningReassessmentFingerprint, MAX_REASSESSMENT_BINDINGS } from "./reassessment-state.js";
import { reconcileCommittedReassessment } from "./reassessment-receipt.js";
import { MAX_CO_WORKER_REVIEW_PROGRESS_AGE_MS, type CoWorkerReviewProgress } from "./review-progress.js";

/** Scheduled internal knowledge maintenance shares the processing controls and budget. */
export class ScheduledLearningReassessment implements LearningReassessmentLifecycle {
  private readonly store;
  private readonly clock;
  private started = false;
  private generation = 0;
  private armRevision = 0;
  private active: { abort: AbortController; promise: Promise<void> } | undefined;
  private notBefore = 0;
  private reason: string | undefined;
  private preferencesKey = "";
  private previousProfile: string | undefined;
  private previouslyPaused = false;
  private publishedStatus = "";

  constructor(private readonly options: {
    directory: string; environmentId: string; context: LearningBackgroundContext;
    memory: LearningMemoryService; model: PassiveLearningModel;
    resourceUsage(): Promise<CoWorkerResourceUsage & { activeCalls: number }>;
    changed?(): void; now?: () => number;
  }) {
    this.store = createReassessmentStateStore(options.directory);
    this.clock = new LearningAnalysisClock(() => this.dispatch(), () => this.now());
  }

  async start(): Promise<void> {
    this.started = true; this.preferencesKey = this.processingPreferencesKey();
    this.previousProfile = this.preferences().modelProfileId;
    this.previouslyPaused = this.preferences().processingPaused === true;
    this.notBefore = this.now() + this.interval(); await this.arm();
  }
  async stop(): Promise<void> {
    this.started = false; this.armRevision += 1; this.clock.clear(true);
    this.active?.abort.abort(new Error("learning_stopped"));
    await this.active?.promise;
  }
  async preferencesChanged(): Promise<void> {
    await this.reschedulePreferences().catch((error) => this.fail(error));
  }
  private async reschedulePreferences(): Promise<void> {
    const key = this.processingPreferencesKey();
    if (key === this.preferencesKey) {
      await this.arm();
      return;
    }
    const explicitRetry = this.previousProfile !== this.preferences().modelProfileId ||
      (this.previouslyPaused && !this.preferences().processingPaused);
    this.generation += 1; this.armRevision += 1; this.clock.clear(true);
    this.active?.abort.abort(new Error("learning_processing_preferences_changed"));
    await this.active?.promise;
    if (explicitRetry) await this.store.retryBlocked();
    this.previousProfile = this.preferences().modelProfileId;
    this.previouslyPaused = this.preferences().processingPaused === true;
    this.preferencesKey = key;
    this.notBefore = this.now() + this.interval(); this.reason = undefined;
    await this.arm();
  }
  knowledgeChanged(): void { void this.arm().catch((error) => this.fail(error)); }
  beginInteractive(): () => void {
    this.armRevision += 1; this.clock.clear();
    this.active?.abort.abort(new Error("learning_interactive_preempted"));
    let released = false;
    return () => { if (!released) { released = true; this.knowledgeChanged(); } };
  }
  status(): LearningReassessmentStatus {
    const state = this.preferences().processingPaused || !this.preferences().modelProfileId ? "off" :
      this.active ? "reviewing" : this.reason?.includes("budget_exhausted") || this.reason === "learning_receipt_capacity" ? "budget_limited" : this.reason ? "failed" : "waiting";
    return { state, ...(this.reason ? { reason: this.reason } : {}),
      ...(this.clock.scheduledAt ? { nextReviewAt: new Date(this.clock.scheduledAt).toISOString() } : {}) };
  }

  private dispatch(): void {
    if (this.active || !this.canRun()) { this.knowledgeChanged(); return; }
    const abort = new AbortController();
    const promise = Promise.resolve().then(() => this.run(abort.signal)).catch((error) => {
      if (!abort.signal.aborted) this.fail(error);
    }).finally(() => {
      this.active = undefined; this.publish(); this.knowledgeChanged();
    });
    this.active = { abort, promise }; this.publish();
  }

  private async run(signal: AbortSignal): Promise<void> {
    const generation = this.generation;
    this.assertCurrent(signal, generation);
    if (!this.insideWindow()) return;
    const usage = await this.options.resourceUsage();
    const deferred = learningBudgetDeferral(usage, this.preferences());
    if (deferred) { this.notBefore = deferred.until; this.reason = deferred.reason; return; }
    if (usage.activeCalls > 0) { this.notBefore = this.now() + this.interval(); return; }
    const admission = await this.options.memory.reviewAdmission();
    if (!admission.available) {
      this.notBefore = admission.retryAt ? Date.parse(admission.retryAt) : Number.POSITIVE_INFINITY;
      this.reason = "learning_receipt_capacity"; return;
    }
    const state = await reconcileCommittedReassessment(this.store, this.options.memory);
    const context = await this.options.memory.reconsiderationContext({ exclude: state.blockedEntries });
    if (!context.entries.length) return;
    const fingerprint = learningReassessmentFingerprint(context);
    const entries = context.entries.map(({ kind, id, version }) => ({ kind, id, version }));
    const reserved = await this.store.reserve(fingerprint, entries, this.now(), () => this.assertCurrent(signal, generation));
    if (!reserved) return;
    this.notBefore = this.now() + this.interval();
    try {
      if (!this.options.model.review) throw new Error("learning_review_unavailable");
      const cause = { kind: "scheduled_knowledge_review" as const,
        dueEntries: entries };
      const batchId = `reassess-${fingerprint}`;
      const policy = await this.options.memory.policy();
      const canResumeProgress = state.fingerprint === fingerprint && state.reviewProgress && this.now() < Date.parse(state.reviewProgress.expiresAt);
      let reviewProgress = canResumeProgress ? state.reviewProgress : undefined;
      const expiresAt = reviewProgress?.expiresAt ?? new Date(this.now() + MAX_CO_WORKER_REVIEW_PROGRESS_AGE_MS).toISOString();
      const progress = { read: () => reviewProgress,
        save: async (next: CoWorkerReviewProgress | undefined): Promise<void> => {
          this.assertCurrent(signal, generation);
          try { await this.store.saveProgress(fingerprint, entries, next, () => this.assertCurrent(signal, generation)); }
          catch {
            this.assertCurrent(signal, generation);
            throw new Error("learning_review_progress_storage_unavailable");
          }
          reviewProgress = next;
        } };
      const decisions = await this.options.model.review({ batchId, modelProfileId: this.preferences().modelProfileId!,
        observations: [], context, cause, promotionScore: policy.promotionScore, signal, progress, expiresAt });
      this.assertCurrent(signal, generation);
      await this.options.memory.apply({ batchId, batchExpiresAt: new Date(this.now() + 86_400_000).toISOString(),
        environmentId: this.options.environmentId, observations: [], context, cause, decisions, policy, abortSignal: signal });
      await this.store.complete(fingerprint, entries);
      this.reason = undefined;
      this.options.changed?.(); this.publish();
    } catch (error) {
      const retryable = signal.aborted || isRetryableReassessmentFailure(error);
      await this.store.failed(fingerprint, entries, safeFailure(error), retryable);
      if (isLearningDailyBudgetFailure(error)) { this.notBefore = usage.resetsAt; this.reason = error.message; return; }
      throw error;
    }
  }

  private async arm(): Promise<void> {
    try { await this.schedule(); } finally { this.publish(); }
  }
  private async schedule(): Promise<void> {
    const revision = ++this.armRevision;
    this.clock.clear();
    if (!this.canRun() || this.active) return;
    let state = await reconcileCommittedReassessment(this.store, this.options.memory);
    if (state.reviewProgress) state = await this.store.resumeProgress(this.now());
    if (state.blockedEntries.length >= MAX_REASSESSMENT_BINDINGS) {
      this.reason = "learning_reassessment_capacity"; return;
    }
    const next = await this.options.memory.nextReconsiderationAt({ exclude: state.blockedEntries });
    if (next === null) { this.reason ??= state.reason ?? undefined; return; }
    const usage = await this.options.resourceUsage();
    const deferred = learningBudgetDeferral(usage, this.preferences());
    if (deferred) this.reason = deferred.reason;
    const admission = await this.options.memory.reviewAdmission();
    if (!admission.available) this.reason = "learning_receipt_capacity";
    const admittedAt = admission.available ? 0 : admission.retryAt ? Date.parse(admission.retryAt) : Number.POSITIVE_INFINITY;
    const earliest = Math.max(Date.parse(next), this.now(), state.attemptedAt + this.interval(), this.notBefore, deferred?.until ?? 0, admittedAt);
    if (revision !== this.armRevision || !this.canRun() || this.active) return;
    if (!Number.isFinite(earliest)) return;
    this.clock.dispatched(earliest, 0);
    this.clock.arm(this.now(), 0, this.preferences().analysisWindow);
  }
  private canRun(ignoreQueuedWork = false): boolean {
    if (!this.started || !this.options.context.isStarted()) return false;
    if (this.preferences().processingPaused || !this.preferences().modelProfileId) return false;
    if (this.options.context.isInteractiveBusy()) return false;
    if (!ignoreQueuedWork && this.options.context.isProcessingBusy?.()) return false;
    return true;
  }
  private assertCurrent(signal: AbortSignal, generation: number): void {
    signal.throwIfAborted();
    if (!this.canRun(true) || generation !== this.generation) throw new Error("learning_processing_paused");
  }
  private preferences() { return this.options.context.preferences(); }
  private interval(): number { return (this.preferences().analysisIntervalMinutes ?? 15) * 60_000; }
  private insideWindow(): boolean { return isWithinAnalysisWindow(this.now(), this.preferences().analysisWindow); }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private fail(error: unknown): void { this.reason = safeFailure(error); this.publish(); }
  private publish(): void {
    const status = JSON.stringify(this.status());
    if (status === this.publishedStatus) return;
    this.publishedStatus = status; this.options.context.changed();
  }
  private processingPreferencesKey(): string {
    const p = this.preferences();
    return JSON.stringify([p.processingPaused, p.modelProfileId, p.analysisIntervalMinutes,
      p.analysisWindow, p.maxConcurrentBatches, p.maturation, p.resourceLimits]);
  }
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,100}$/u.test(message) ? message : "learning_reassessment_failed";
}
function isRetryableReassessmentFailure(error: unknown): boolean {
  if (isLearningDailyBudgetFailure(error)) return true;
  if (!(error instanceof Error)) return false;
  return ["co_worker_resources_busy", "learning_outside_processing_window", "learning_processing_paused", "learning_knowledge_conflict", "learning_receipt_capacity", "learning_memory_unavailable",
    "learning_review_progress_capacity", "learning_review_progress_storage_unavailable", "learning_review_progress_expired"].includes(error.message);
}
