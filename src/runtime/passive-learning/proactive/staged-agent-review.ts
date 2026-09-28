import { randomUUID } from "node:crypto";
import type { LearningKnowledgeContext, LearningMemoryService } from "../../long-term-memory/maturation/contracts.js";
import type { ReviewProgressPort } from "../review-progress.js";
import { hasExactProactiveSource, hasProactiveReviewAttempt, type ProactiveState } from "./contracts.js";
import type { RuntimeProactiveModel } from "./model.js";
import type { createProactiveStateStore } from "./store.js";

/** SUPER alone resumes a running review; EA retains its existing receipt lifecycle. */
export async function runStagedProactiveAgentReview(options: Readonly<{
  state: ProactiveState; context: LearningKnowledgeContext; profileId: string;
  store: ReturnType<typeof createProactiveStateStore>; memory: LearningMemoryService; model: RuntimeProactiveModel;
  signal: AbortSignal; now(): number; assertCurrent(): void;
}>): Promise<ProactiveState | undefined> {
  const { store, context, profileId, signal } = options;
  options.assertCurrent();
  const currentSources = await options.memory.sourceVersions();
  options.assertCurrent();
  if (!context.entries.every(source => hasExactProactiveSource(currentSources, source))) throw new Error("proactive_superseded");
  const resumable = hasProactiveReviewAttempt(options.state, context.knowledgeRevision, profileId);
  if (resumable && options.state.reviewAttempt?.status === "failed") return undefined;
  const reserved = resumable ? options.state : await store.reserveReviewAttempt({
    reviewId: randomUUID(), expectedRevision: options.state.revision, knowledgeRevision: context.knowledgeRevision,
    profileId, method: "super-v2", now: options.now(), assertCurrent: options.assertCurrent,
  });
  if (!reserved?.reviewAttempt) return undefined;
  const reviewId = reserved.reviewAttempt.reviewId;
  let current = reserved;
  const progress: ReviewProgressPort = {
    read: () => current.reviewProgress,
    async save(value) {
      current = await store.saveReviewProgress({ reviewId, expectedRevision: current.revision, progress: value,
        assertCurrent: options.assertCurrent });
    },
  };
  try {
    const decision = await options.model.review({ reviewId, modelProfileId: profileId,
      context, recentProposals: reserved.proposals, signal, progress });
    options.assertCurrent();
    return await store.commitReview({ reviewId, expectedRevision: current.revision,
      knowledgeRevision: context.knowledgeRevision, decision, now: options.now(), assertCurrent: options.assertCurrent });
  } catch (error) {
    if (!isStagedProactiveInterruption(error, signal)) await store.failReviewAttempt(reviewId, safeStagedFailure(error), false);
    throw error;
  }
}

function isStagedProactiveInterruption(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (!(error instanceof Error)) return false;
  return ["co_worker_model_daily_budget_exhausted", "co_worker_resources_busy", "proactive_outside_window",
    "proactive_disabled", "proactive_superseded", "proactive_revision_conflict",
    "learning_review_progress_expired"].includes(error.message);
}

function safeStagedFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return /^[a-z][a-z0-9_]{0,100}$/u.test(code) ? code : "proactive_failed";
}
