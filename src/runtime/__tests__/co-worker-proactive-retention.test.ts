import { expect, test } from "vitest";
import { MAX_PROACTIVE_REVIEW_PROGRESS_AGE_MS } from "../passive-learning/proactive/staged-contract.js";
import { readCoWorkerReviewProgress } from "../passive-learning/review-progress.js";

test("long proactive retention does not widen the default learning checkpoint reader", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const progress = { schemaVersion: 1, method: "super-v2", binding: "a".repeat(64),
    referenceTime: new Date(now).toISOString(), expiresAt: new Date(now + MAX_PROACTIVE_REVIEW_PROGRESS_AGE_MS).toISOString(), stages: [] };
  expect(() => readCoWorkerReviewProgress(progress)).toThrow("learning_review_progress_invalid");
  expect(readCoWorkerReviewProgress(progress, MAX_PROACTIVE_REVIEW_PROGRESS_AGE_MS)).toEqual(progress);
  expect(() => readCoWorkerReviewProgress({ ...progress, expiresAt: new Date(now + MAX_PROACTIVE_REVIEW_PROGRESS_AGE_MS + 1).toISOString() }, MAX_PROACTIVE_REVIEW_PROGRESS_AGE_MS)).toThrow("learning_review_progress_invalid");
});
