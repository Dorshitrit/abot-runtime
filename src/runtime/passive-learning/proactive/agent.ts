import { randomUUID } from "node:crypto";
import type { LearningMemoryService } from "../../long-term-memory/maturation/contracts.js";
import type { SessionStore } from "../../ports.js";
import type { LearningBackgroundContext } from "../background-dependencies.js";
import type { ProactiveStatus } from "../contracts.js";
import { LearningAnalysisClock } from "../analysis-clock.js";
import { isWithinAnalysisWindow, nextAnalysisInstant } from "../analysis-schedule.js";
import type { CoWorkerResourceBudget } from "../resources/budget.js";
import { canDeliverProactiveProposal, hasProactiveReviewAttempt, isPendingProposalCurrent, isProactiveReviewEligible, type ProactiveProposal, type ProactiveState } from "./contracts.js";
import { countProactiveDeliveries, createProactiveStateStore } from "./store.js";
import type { createRuntimeProactiveModel } from "./model.js";
import { runStagedProactiveAgentReview } from "./staged-agent-review.js";
import { canResumeStagedProactiveAttempt, hasCompletedStagedProactiveProgress,
  hasExpiredStagedProactiveProgress } from "./staged-progress-store.js";

export class CoWorkerProactiveAgent {
  private readonly store;
  private readonly clock;
  private started = false;
  private generation = 0;
  private active: { abort: AbortController; promise: Promise<void>; delivering?: boolean; stagedReview?: boolean } | undefined;
  private reviewNotBefore = 0;
  private retryNotBefore = 0;
  private reason: string | undefined;
  private controls: Promise<unknown> = Promise.resolve();
  private armRevision = 0;
  private preferencesKey: string | undefined;
  private previousInterval = 0;

  constructor(private readonly options: {
    directory: string; context: LearningBackgroundContext; memory: LearningMemoryService;
    model: ReturnType<typeof createRuntimeProactiveModel>; sessions: SessionStore;
    budget: CoWorkerResourceBudget; now?: () => number;
  }) {
    this.store = createProactiveStateStore(options.directory);
    this.clock = new LearningAnalysisClock(() => this.dispatch(), () => this.now());
  }

  async start(): Promise<void> {
    this.started = true;
    this.preferencesKey = this.currentPreferencesKey();
    this.previousInterval = this.interval();
    this.reviewNotBefore = this.now() + this.interval();
    await this.arm();
  }
  async stop(): Promise<void> {
    this.started = false;
    this.armRevision += 1;
    this.clock.clear(true);
    this.active?.abort.abort(new Error("proactive_stopped"));
    await this.active?.promise;
  }
  async preferencesChanged(): Promise<void> {
    await this.reschedulePreferences().catch((error) => this.fail(error));
  }
  private async reschedulePreferences(): Promise<void> {
    const key = this.currentPreferencesKey();
    if (key === this.preferencesKey) return;
    this.generation += 1;
    this.armRevision += 1;
    this.clock.clear(true);
    this.active?.abort.abort(new Error("proactive_preferences_changed"));
    await this.active?.promise;
    const state = await this.store.read();
    const profile = this.preferences().proactiveModelProfileId ?? this.preferences().modelProfileId;
    if (this.canRetainStagedAttempt(state, profile)) await this.store.resumeStagedReviewAttempt();
    else await this.store.clearReviewAttempt();
    if (hasExpiredStagedProactiveProgress(state, this.now())) await this.store.expireReviewProgress(this.now());
    this.reason = undefined;
    if (!this.preferences().proactiveEnabled) await this.store.cancelPending(this.now());
    const intervalChanged = this.interval() !== this.previousInterval;
    const retryNeedsRescheduling = intervalChanged && this.retryNotBefore > this.now();
    if (intervalChanged) this.reviewNotBefore = this.now() + this.interval();
    if (retryNeedsRescheduling) this.retryNotBefore = this.reviewNotBefore;
    this.previousInterval = this.interval();
    this.preferencesKey = key;
    await this.arm();
  }
  knowledgeChanged(): void {
    if (this.active?.delivering || this.active?.stagedReview) {
      this.generation += 1;
      this.active.abort.abort(new Error("proactive_superseded"));
    }
    void this.arm().catch((error) => this.fail(error));
  }
  beginInteractive(): () => void {
    this.armRevision += 1;
    this.clock.clear();
    this.active?.abort.abort(new Error("proactive_interactive_preempted"));
    return () => this.knowledgeChanged();
  }
  async dismiss(id: string): Promise<void> {
    await this.store.dismiss(id, this.now());
    this.options.context.changed();
  }
  async sessionDeleted(sessionId: string): Promise<void> {
    const state = await this.store.read();
    const proposal = state.proposals.find((item) => item.sessionId === sessionId);
    if (proposal) await this.dismiss(proposal.id);
  }
  async status(): Promise<ProactiveStatus> {
    const [state, usage] = await Promise.all([this.store.read(), this.options.budget.status()]);
    return { state: this.stateLabel(), proposals: state.proposals.slice(-20),
      deliveredToday: countProactiveDeliveries(state, usage.startedAt),
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.clock.scheduledAt ? { nextReviewAt: new Date(this.clock.scheduledAt).toISOString() } : {}) };
  }

  private dispatch(): void {
    if (!this.canRun() || this.active) return;
    const abort = new AbortController();
    const promise = Promise.resolve().then(() => this.run(abort.signal)).catch((error) => {
      if (!abort.signal.aborted) this.fail(error);
    }).finally(() => {
      this.active = undefined;
      this.options.context.changed();
      this.knowledgeChanged();
    });
    this.active = { abort, promise };
    this.options.context.changed();
  }
  private async run(signal: AbortSignal): Promise<void> {
    const generation = this.generation;
    let state = await this.store.read();
    if (this.usesStagedReview() && hasExpiredStagedProactiveProgress(state, this.now())) state = await this.store.expireReviewProgress(this.now());
    if (await this.deliverPending(state, signal, generation)) return;
    const usage = await this.options.budget.status();
    if (this.limitReached(state, usage, this.canCompleteSavedReview(state))) return;
    const context = await this.options.memory.overview();
    const last = state.lastReviewedAt ? Date.parse(state.lastReviewedAt) : 0;
    const eligible = isProactiveReviewEligible({ enabled: this.canRun(), insideWindow: this.insideWindow(),
      interactiveBusy: this.options.context.isInteractiveBusy(), now: this.now(), nextAllowedAt: Math.max(this.retryNotBefore, this.reviewNotBefore, last + this.interval()),
      knowledgeRevision: context.knowledgeRevision, hasKnowledge: context.entries.length > 0, state });
    if (!eligible) return;
    this.reviewNotBefore = this.now() + this.interval();
    const profile = this.preferences().proactiveModelProfileId ?? this.preferences().modelProfileId;
    if (!profile) throw new Error("proactive_model_required");
    if (this.usesStagedReview()) {
      if (this.active) this.active.stagedReview = true;
      const committed = await runStagedProactiveAgentReview({ state, context, profileId: profile,
        store: this.store, memory: this.options.memory, model: this.options.model, signal,
        now: () => this.now(), assertCurrent: () => this.assertCurrent(signal, generation) });
      if (!committed) return;
      this.reason = undefined;
      this.options.context.changed();
      await this.deliverPending(committed, signal, generation);
      return;
    }
    if (hasProactiveReviewAttempt(state, context.knowledgeRevision, profile)) return;
    const reviewId = randomUUID();
    const reserved = await this.store.reserveReviewAttempt({ reviewId, expectedRevision: state.revision,
      knowledgeRevision: context.knowledgeRevision, profileId: profile, now: this.now(),
      assertCurrent: () => this.assertCurrent(signal, generation) });
    if (!reserved) return;
    let committed: ProactiveState;
    try {
      const decision = await this.options.model.review({ reviewId, modelProfileId: profile,
        context, recentProposals: state.proposals, signal });
      signal.throwIfAborted();
      // Window closure may settle this response, but cannot admit another call or delivery.
      committed = await this.store.commitReview({ reviewId, expectedRevision: reserved.revision,
        knowledgeRevision: context.knowledgeRevision, decision, now: this.now(),
        assertCurrent: () => this.assertCurrent(signal, generation) });
    } catch (error) {
      await this.store.failReviewAttempt(reviewId, safeFailure(error), signal.aborted || isRetryableReviewFailure(error));
      throw error;
    }
    this.reason = undefined;
    this.options.context.changed();
    await this.deliverPending(committed, signal, generation);
  }

  private async deliverPending(state: ProactiveState, signal: AbortSignal, generation: number): Promise<boolean> {
    const pending = state.proposals.find((proposal) => isPendingProposalCurrent(proposal, this.now()));
    if (!pending) return false;
    if (this.active) this.active.delivering = true;
    if (!this.insideWindow()) return true;
    const usage = await this.options.budget.status();
    const delivered = countProactiveDeliveries(state, usage.startedAt);
    if (delivered >= (this.preferences().proactiveMessagesPerDay ?? 2)) {
      this.reason = "proactive_daily_message_limit_reached";
      return true;
    }
    const currentSources = await this.options.memory.sourceVersions();
    if (!canDeliverProactiveProposal({ proposal: pending, enabled: this.canRun(), insideWindow: this.insideWindow(),
      generationCurrent: generation === this.generation, now: this.now(), currentSources })) {
      await this.store.cancelPending(this.now());
      return true;
    }
    this.assertCurrent(signal, generation);
    await this.deliver(pending, signal, generation);
    return true;
  }

  private deliver(proposal: ProactiveProposal, signal: AbortSignal, generation: number): Promise<void> {
    const next = this.controls.then(async () => {
      this.assertCurrent(signal, generation);
      if (!this.insideWindow()) return;
      if (!this.options.sessions.createAssistantConversation) throw new Error("proactive_session_delivery_unavailable");
      await this.options.sessions.createAssistantConversation(proposal.sessionId, {
        title: proposal.title, content: proposal.message,
        initiative: { kind: "proactive_proposal_v1", proposalId: proposal.id, reason: proposal.reason, sources: proposal.sources },
        assertCurrent: () => {
          this.assertCurrent(signal, generation);
          if (!this.insideWindow()) throw new Error("proactive_outside_window");
        },
      });
      const usage = await this.options.budget.ensureCurrentWindow();
      await this.store.markDelivered(proposal.id, this.now(), usage.startedAt);
      if (this.canRun() && generation === this.generation && !signal.aborted)
        this.options.context.changed({ type: "proposal_delivered", proposalId: proposal.id, sessionId: proposal.sessionId });
    });
    this.controls = next.catch(() => {});
    return next;
  }

  private async arm(): Promise<void> {
    const revision = ++this.armRevision;
    const before = this.scheduleKey();
    if (!this.canRun() || this.active) return;
    let state = await this.store.read();
    if (this.usesStagedReview() && hasExpiredStagedProactiveProgress(state, this.now())) state = await this.store.expireReviewProgress(this.now());
    const context = await this.options.memory.overview();
    const pending = state.proposals.some((proposal) => isPendingProposalCurrent(proposal, this.now()));
    const profile = this.preferences().proactiveModelProfileId ?? this.preferences().modelProfileId;
    const attempted = profile && hasProactiveReviewAttempt(state, context.knowledgeRevision, profile);
    const resumable = this.usesStagedReview() && canResumeStagedProactiveAttempt(state);
    if (!pending && attempted && !resumable) {
      if (revision === this.armRevision) {
        this.clock.clear();
        this.reason = state.reviewAttempt?.reason ?? "proactive_review_interrupted";
        this.publishScheduleChange(before);
      }
      return;
    }
    if (state.reviewAttempt && !attempted) this.reason = undefined;
    const newKnowledge = context.entries.length > 0 && context.knowledgeRevision !== state.reviewedKnowledgeRevision;
    const hasReassessment = context.entries.length > 0 && state.nextReviewAt !== null;
    if (!pending && !newKnowledge && !hasReassessment) {
      if (revision === this.armRevision) {
        this.clock.clear();
        this.reason = undefined;
        this.publishScheduleChange(before);
      }
      return;
    }
    const usage = await this.options.budget.status();
    let earliest = Math.max(this.retryNotBefore, this.now());
    if (!pending) earliest = Math.max(earliest, this.reviewNotBefore);
    if (state.lastReviewedAt && !pending) earliest = Math.max(earliest, Date.parse(state.lastReviewedAt) + this.interval());
    if (!pending && !newKnowledge && state.nextReviewAt) earliest = Math.max(earliest, Date.parse(state.nextReviewAt));
    if (this.limitReached(state, usage, pending || this.canCompleteSavedReview(state))) earliest = Math.max(earliest, usage.resetsAt);
    const due = nextAnalysisInstant(earliest, this.preferences().proactiveWindow);
    if (!this.canRun() || this.active || revision !== this.armRevision) return;
    this.clock.clear();
    this.clock.dispatched(due, 0);
    this.clock.arm(this.now(), 0, this.preferences().proactiveWindow);
    this.publishScheduleChange(before);
  }
  private scheduleKey(): string { return `${this.reason ?? ""}:${this.clock.scheduledAt ?? ""}`; }
  private publishScheduleChange(previous: string): void {
    if (previous !== this.scheduleKey()) this.options.context.changed();
  }
  private assertCurrent(signal: AbortSignal, generation: number): void {
    signal.throwIfAborted();
    if (!this.canRun() || generation !== this.generation) throw new Error("proactive_superseded");
  }
  private limitReached(state: ProactiveState, usage: { startedAt: number; modelCalls: number }, pending = false): boolean {
    if (countProactiveDeliveries(state, usage.startedAt) >= (this.preferences().proactiveMessagesPerDay ?? 2)) {
      this.reason = "proactive_daily_message_limit_reached";
      return true;
    }
    if (!pending && usage.modelCalls >= (this.preferences().resourceLimits?.modelCallsPerDay ?? 24)) {
      this.reason = "co_worker_model_daily_budget_exhausted";
      return true;
    }
    if (this.reason === "proactive_daily_message_limit_reached" || this.reason === "co_worker_model_daily_budget_exhausted") this.reason = undefined;
    return false;
  }
  private canRun(): boolean {
    if (!this.started || !this.options.context.isStarted()) return false;
    if (!this.preferences().proactiveEnabled) return false;
    return !this.options.context.isInteractiveBusy();
  }
  private insideWindow(): boolean { return isWithinAnalysisWindow(this.now(), this.preferences().proactiveWindow); }
  private preferences() { return this.options.context.preferences(); }
  private usesStagedReview(): boolean {
    const profile = this.preferences().proactiveModelProfileId ?? this.preferences().modelProfileId;
    if (!profile) return false;
    return this.options.model.reviewMethod?.(profile) === "staged";
  }
  private canRetainStagedAttempt(state: ProactiveState, profile: string | undefined): boolean {
    if (!this.usesStagedReview()) return false;
    if (state.reviewAttempt?.method !== "super-v2") return false;
    return state.reviewAttempt.profileId === profile;
  }
  private canCompleteSavedReview(state: ProactiveState): boolean {
    if (!this.usesStagedReview()) return false;
    return hasCompletedStagedProactiveProgress(state, this.now());
  }
  private currentPreferencesKey(): string {
    const value = this.preferences();
    return JSON.stringify([value.proactiveEnabled, value.proactiveModelProfileId ?? value.modelProfileId,
      value.proactiveIntervalMinutes, value.proactiveWindow, value.proactiveMessagesPerDay, value.resourceLimits]);
  }
  private interval(): number { return (this.preferences().proactiveIntervalMinutes ?? 60) * 60_000; }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private fail(error: unknown): void {
    this.retryNotBefore = this.now() + this.interval();
    this.reason = safeFailure(error);
    this.options.context.changed();
  }
  private stateLabel(): ProactiveStatus["state"] {
    if (!this.preferences().proactiveEnabled) return "off";
    if (this.active) return "reviewing";
    if (this.reason?.includes("budget_exhausted")) return "budget_limited";
    if (this.reason === "proactive_daily_message_limit_reached") return "budget_limited";
    if (this.reason) return "failed";
    return "waiting";
  }
}

function safeFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,100}$/u.test(code) ? code : "proactive_failed";
}
function isRetryableReviewFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return ["co_worker_model_daily_budget_exhausted", "co_worker_resources_busy", "proactive_outside_window",
    "proactive_disabled", "proactive_superseded", "proactive_revision_conflict"].includes(error.message);
}
