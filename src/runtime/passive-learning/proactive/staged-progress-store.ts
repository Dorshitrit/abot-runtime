import { MAX_PROACTIVE_REVIEW_PROGRESS_AGE_MS } from "./staged-contract.js";
import { readCoWorkerReviewProgress, type CoWorkerReviewProgress } from "../review-progress.js";
import type { ProactiveState } from "./contracts.js";

type ProactiveStateUpdate = (change: (current: ProactiveState) => ProactiveState) => Promise<ProactiveState>;

/** Checkpoints share the existing atomic proactive state writer and its revision. */
export function createProactiveReviewProgressStore(update: ProactiveStateUpdate) {
  return {
    saveReviewProgress(input: Readonly<{
      reviewId: string; expectedRevision: number; progress: CoWorkerReviewProgress | undefined;
      assertCurrent(): void;
    }>): Promise<ProactiveState> {
      return update(current => {
        input.assertCurrent();
        if (current.revision !== input.expectedRevision) throw new Error("proactive_revision_conflict");
        if (current.reviewAttempt?.reviewId !== input.reviewId) throw new Error("proactive_review_attempt_conflict");
        if (current.reviewAttempt.status !== "running") throw new Error("proactive_review_attempt_conflict");
        const progress = readCoWorkerReviewProgress(input.progress, MAX_PROACTIVE_REVIEW_PROGRESS_AGE_MS);
        if (progress === undefined) return withoutProactiveReviewProgress(current);
        return { ...current, reviewProgress: progress };
      });
    },
    resumeStagedReviewAttempt(): Promise<ProactiveState> {
      return update(current => {
        if (!current.reviewAttempt) return current;
        if (current.reviewAttempt.status !== "failed") return current;
        const { reason: _reason, ...attempt } = current.reviewAttempt;
        return { ...current, reviewAttempt: { ...attempt, status: "running" } };
      });
    },
    expireReviewProgress(now: number): Promise<ProactiveState> {
      return update(current => {
        if (!current.reviewProgress) return current;
        if (Date.parse(current.reviewProgress.expiresAt) > now) return current;
        return withoutProactiveReviewProgress(current);
      });
    },
  };
}

function withoutProactiveReviewProgress(state: ProactiveState): ProactiveState {
  if (!state.reviewProgress) return state;
  const { reviewProgress: _progress, ...rest } = state;
  return rest;
}

export function canResumeStagedProactiveAttempt(state: ProactiveState): boolean {
  if (state.reviewAttempt?.method !== "super-v2") return false;
  return state.reviewAttempt?.status === "running";
}

export function hasExpiredStagedProactiveProgress(state: ProactiveState, now: number): boolean {
  if (!state.reviewProgress) return false;
  return Date.parse(state.reviewProgress.expiresAt) <= now;
}
