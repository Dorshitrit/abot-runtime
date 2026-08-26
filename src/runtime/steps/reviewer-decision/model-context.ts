import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ReviewerReviewSnapshot } from "./contracts.js";

export const REVIEWER_AUDIT_CONTEXT_KIND = "runtime_reviewer_audit_v2" as const;
export const REVIEWER_EVIDENCE_APPENDIX_KIND =
  "runtime_reviewer_evidence_v1" as const;
const REVIEWER_CANDIDATE_SUPPORT_RELATION = "candidate_support" as const;

export type ReviewerModelContextProjection = Readonly<{
  referenceMessages: readonly ChatMessage[];
  prompt: string;
  completionTargetLength: number;
  auditCapsuleCharacterCount: number;
  evidenceAppendixCharacterCount: number;
}>;

/**
 * Projects one authority-first Reviewer context from canonical snapshot facts.
 * Large evidence bodies are pinned before the final compact audit capsule so
 * they remain available without displacing the completion target from recency.
 */
export function projectReviewerModelContext(
  snapshot: ReviewerReviewSnapshot,
): ReviewerModelContextProjection {
  const completionTargets = snapshot.subjects.filter(
    ({ kind }) => kind === "caller_objective",
  );
  if (completionTargets.length !== 1) {
    throw new Error("reviewer_completion_target_invalid");
  }
  const completionTarget = completionTargets[0]!;
  const candidateSupportSubjectRefs = new Set(
    [...snapshot.facts, ...snapshot.evidence].flatMap(
      ({ subjectRefs }) => subjectRefs,
    ),
  );
  const candidateSupportEdges = snapshot.subjects.flatMap((subject) =>
    subject.subjectRef !== completionTarget.subjectRef &&
    candidateSupportSubjectRefs.has(subject.subjectRef)
      ? [
          {
            sourceSubjectRef: subject.subjectRef,
            targetSubjectRef: completionTarget.subjectRef,
            relation: REVIEWER_CANDIDATE_SUPPORT_RELATION,
          },
        ]
      : [],
  );
  const referenceMessages = snapshot.evidence.flatMap((item) =>
    item.referenceData
      ? [
          Object.freeze({
            role: "user" as const,
            content: [
              JSON.stringify({
                kind: REVIEWER_EVIDENCE_APPENDIX_KIND,
                authority: "reference_data",
                evidenceRef: item.evidenceRef,
                outcome: item.outcome,
                effect: item.effect,
                summary: item.summary,
                ...(item.references ? { references: item.references } : {}),
              }),
              "BEGIN BOUNDED EVIDENCE CONTENT",
              item.referenceData,
              "END BOUNDED EVIDENCE CONTENT",
            ].join("\n"),
          }),
        ]
      : [],
  );
  const claims = snapshot.facts.map((item) => ({
    claimRef: item.factRef,
    status: item.status,
    summary: item.summary,
    subjectRefs: item.subjectRefs,
    evidenceRefs: item.evidenceRefs,
  }));
  const effects = snapshot.evidence.map((item) => ({
    evidenceRef: item.evidenceRef,
    outcome: item.outcome,
    effect: item.effect,
    summary: item.summary,
    subjectRefs: item.subjectRefs,
    ...(item.references ? { references: item.references } : {}),
    referenceDataSupplied: item.referenceData !== undefined,
  }));
  const prompt = JSON.stringify({
    kind: REVIEWER_AUDIT_CONTEXT_KIND,
    auditScope: {
      reviewScopeId: snapshot.reviewScopeId,
      sourceRevision: snapshot.sourceRevision,
      evidenceProjectionComplete: snapshot.projectionComplete,
      evidenceLedgerState:
        snapshot.freshness === "current"
          ? "current_revision"
          : snapshot.freshness,
    },
    candidateSupportPolicy: {
      authority: "runtime_projection",
      sourceClaimsAndEffectsMaySupportTarget: true,
      edgeAloneEstablishesCompletion: false,
      distinctSourceAndTargetRefsExpected: true,
    },
    candidateSupportEdges,
    claims,
    effects,
    completionTarget: {
      authority: "caller",
      subjectRef: completionTarget.subjectRef,
      text: completionTarget.summary,
    },
  });
  return Object.freeze({
    referenceMessages: Object.freeze(referenceMessages),
    prompt,
    completionTargetLength: completionTarget.summary.length,
    auditCapsuleCharacterCount: prompt.length,
    evidenceAppendixCharacterCount: referenceMessages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
  });
}
