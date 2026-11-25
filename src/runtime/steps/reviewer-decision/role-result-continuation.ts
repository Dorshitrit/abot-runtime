import type { ChatMessage } from "../../../model-gateway/types.js";
import {
  REVIEWER_EVIDENCE_REFERENCE_DATA_MAX_LENGTH,
  type ReviewerDecisionValidationIssue,
  type ReviewerEvidence,
  type ReviewerFact,
} from "./contracts.js";
import { estimateReferenceDataTokens, type ReviewerReferenceDataBudget } from "./final-evidence.js";

/** Role reports remain passive claims, separate from execution evidence. */
export function projectReviewerRoleResultContinuations(
  facts: readonly ReviewerFact[],
  evidence: readonly ReviewerEvidence[],
  budget: ReviewerReferenceDataBudget,
): Readonly<{ facts: readonly ReviewerFact[]; projectionComplete: boolean }> {
  let remaining = Math.max(0, budget.maxTokens - reviewerReferenceDataTokenCount(evidence, [], budget));
  let projectionComplete = true;
  const projected = facts.map((fact) => {
    const continuation = fact.summaryContinuation;
    if (continuation === undefined) return fact;
    const cost = estimateReferenceDataTokens(continuation, budget.tokenEstimation);
    if (canRetainRoleResultContinuation(continuation, cost, remaining)) {
      remaining -= cost;
      return fact;
    }
    projectionComplete = false;
    const { summaryContinuation: _omitted, ...bounded } = fact;
    return bounded;
  });
  return Object.freeze({ facts: Object.freeze(projected), projectionComplete });
}

function canRetainRoleResultContinuation(value: string, cost: number, available: number): boolean {
  if (value.length > REVIEWER_EVIDENCE_REFERENCE_DATA_MAX_LENGTH) return false;
  return cost <= available;
}

export function reviewerReferenceDataTokenCount(
  evidence: readonly ReviewerEvidence[],
  facts: readonly ReviewerFact[],
  budget: ReviewerReferenceDataBudget,
): number {
  return [...evidence.map((item) => item.referenceData), ...facts.map((item) => item.summaryContinuation)]
    .reduce<number>((total, content) => total + (content
      ? estimateReferenceDataTokens(content, budget.tokenEstimation) : 0), 0);
}

export function parseReviewerRoleResultContinuation(
  value: unknown, kind: string | undefined, path: string,
  issues: ReviewerDecisionValidationIssue[],
): string | undefined {
  if (value === undefined) return undefined;
  if (!isRoleResultContinuationValid(value, kind)) {
    issues.push({ code: "reviewer_snapshot_role_result_continuation_invalid", path,
      message: "Only a bounded exact role-result summary continuation is permitted." });
    return undefined;
  }
  return value;
}

function isRoleResultContinuationValid(value: unknown, kind: string | undefined): value is string {
  if (kind !== "role_result") return false;
  if (typeof value !== "string" || value.trim().length === 0) return false;
  return value.length <= REVIEWER_EVIDENCE_REFERENCE_DATA_MAX_LENGTH;
}

export function buildReviewerRoleResultContinuationMessages(facts: readonly ReviewerFact[]): readonly ChatMessage[] {
  return facts.flatMap((fact) => fact.summaryContinuation === undefined ? [] : [Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: "runtime_reviewer_role_result_continuation_v1",
      authority: "canonical_role_call_dependency_result",
      presenceEffect: "Passive role report, not execution evidence, user intent, pending work, completion or a review verdict.",
      resultRef: fact.factRef,
      subjectRefs: fact.subjectRefs,
      retainedSummaryCharacters: fact.summary.length,
      continuation: fact.summaryContinuation,
    }),
  })]);
}
