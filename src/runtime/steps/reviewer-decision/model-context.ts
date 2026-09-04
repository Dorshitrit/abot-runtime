import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RoleCallFrame } from "../../orchestration/role-calls/index.js";
import {
  projectReviewerDecisionCallIdentity,
  type ReviewerReviewSnapshot,
} from "./contracts.js";
import { projectReviewerVerificationCoverage } from "./verification-coverage.js";

export const REVIEWER_AUDIT_CONTEXT_KIND = "runtime_reviewer_audit_v4" as const;
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
  reviewerCall: RoleCallFrame,
): ReviewerModelContextProjection {
  const reviewerIdentity = projectReviewerDecisionCallIdentity(reviewerCall);
  if (
    reviewerIdentity.callId !== snapshot.reviewerCallId ||
    reviewerIdentity.parentCallId !== snapshot.callerCallId
  ) {
    throw new Error("reviewer_assignment_binding_invalid");
  }
  const completionTargets = snapshot.subjects.filter(
    ({ kind }) => kind === "caller_objective",
  );
  if (completionTargets.length !== 1) {
    throw new Error("reviewer_completion_target_invalid");
  }
  const completionTarget = completionTargets[0]!;
  const verificationCoverage = projectReviewerVerificationCoverage(snapshot);
  const dependencyFactsBySubjectRef = projectDependencyFactsBySubjectRef(
    snapshot,
  );
  const dependencySubjects = snapshot.subjects.flatMap((subject) => {
    const dependencyFact = dependencyFactsBySubjectRef.get(subject.subjectRef);
    if (!dependencyFact) return [];
    const producerCallId = subject.subjectRef.startsWith("call:")
      ? subject.subjectRef.slice("call:".length)
      : "";
    const roleId = subject.kind.endsWith("_result")
      ? subject.kind.slice(0, -"_result".length)
      : "";
    if (!producerCallId || !roleId) {
      throw new Error("reviewer_dependency_subject_invalid");
    }
    return [
      {
        authority: "canonical_role_call_dependency_result",
        presenceEffect:
          "passive_support_not_user_intent_pending_work_completion_or_verdict",
        subjectRef: subject.subjectRef,
        resultRef: dependencyFact.factRef,
        producerCallId,
        roleId,
        objective: subject.summary,
        summary: dependencyFact.summary,
        outcome:
          dependencyFact.status === "informational" ? "completed" : "failed",
      },
    ];
  });
  const supportSubjects = snapshot.subjects.flatMap((subject) =>
    subject.subjectRef === completionTarget.subjectRef ||
    dependencyFactsBySubjectRef.has(subject.subjectRef)
      ? []
      : [
          {
            authority: "canonical_review_snapshot",
            presenceEffect:
              "passive_support_descriptor_not_user_intent_pending_work_or_completion",
            subjectRef: subject.subjectRef,
            kind: subject.kind,
            summary: subject.summary,
          },
        ],
  );
  const candidateSupportSubjectRefs = new Set(
    [...snapshot.facts, ...snapshot.evidence].flatMap(
      ({ subjectRefs }) => subjectRefs,
    ),
  );
  const passiveReviewerDependencySubjectRefs = new Set(
    dependencySubjects.flatMap(({ roleId, subjectRef }) =>
      roleId === "reviewer" ? [subjectRef] : [],
    ),
  );
  const candidateSupportEdges = snapshot.subjects.flatMap((subject) =>
    subject.subjectRef !== completionTarget.subjectRef &&
    candidateSupportSubjectRefs.has(subject.subjectRef) &&
    !passiveReviewerDependencySubjectRefs.has(subject.subjectRef)
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
  const claims = snapshot.facts.flatMap((item) =>
    item.kind === "role_result"
      ? []
      : [
          {
            claimRef: item.factRef,
            status: item.status,
            summary: item.summary,
            subjectRefs: item.subjectRefs,
            evidenceRefs: item.evidenceRefs,
          },
        ],
  );
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
    verificationCoverage: {
      authority: "runtime_projection",
      presenceEffect:
        "pass_eligibility_only_not_semantic_completion_proof_or_user_intent",
      ...verificationCoverage,
    },
    assignment: {
      authority: "canonical_reviewer_call",
      callId: reviewerIdentity.callId,
      purpose: "audit_supplied_completion_target",
      presenceEffect: "active_reviewer_assignment_only",
      completionTargetRef: completionTarget.subjectRef,
    },
    dependencySubjects,
    supportSubjects,
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

function projectDependencyFactsBySubjectRef(
  snapshot: ReviewerReviewSnapshot,
) {
  const projected = new Map<string, ReviewerReviewSnapshot["facts"][number]>();
  for (const fact of snapshot.facts) {
    if (fact.kind !== "role_result") continue;
    if (
      fact.subjectRefs.length !== 1 ||
      (fact.status !== "informational" && fact.status !== "missing") ||
      projected.has(fact.subjectRefs[0]!)
    ) {
      throw new Error("reviewer_dependency_fact_invalid");
    }
    projected.set(fact.subjectRefs[0]!, fact);
  }
  return projected;
}
