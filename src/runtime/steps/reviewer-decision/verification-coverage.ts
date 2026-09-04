import type { ReviewerReviewSnapshot } from "./contracts.js";

export type ReviewerVerificationCoverage = Readonly<{
  required: boolean;
  complete: boolean;
  mutationTargetCount: number;
  verifiedTargets: readonly string[];
  missingTargets: readonly string[];
}>;

/**
 * Multi-target mutations need an independent post-mutation observation or a
 * canonical satisfied fact before Reviewer may pass them as one integrated
 * result. This is only a pass-eligibility check; it never proves semantics.
 */
export function projectReviewerVerificationCoverage(
  snapshot: ReviewerReviewSnapshot,
): ReviewerVerificationCoverage {
  const latestMutationByTarget = new Map<
    string,
    Readonly<{ evidenceRef: string; index: number }>
  >();
  snapshot.evidence.forEach((evidence, index) => {
    if (evidence.outcome !== "succeeded" || evidence.effect !== "mutation") {
      return;
    }
    for (const target of evidenceTargets(evidence)) {
      latestMutationByTarget.set(target, {
        evidenceRef: evidence.evidenceRef,
        index,
      });
    }
  });

  const required = latestMutationByTarget.size > 1;
  if (!required) {
    return Object.freeze({
      required: false,
      complete: true,
      mutationTargetCount: latestMutationByTarget.size,
      verifiedTargets: Object.freeze([]),
      missingTargets: Object.freeze([]),
    });
  }

  const satisfiedEvidenceRefs = new Set(
    snapshot.facts.flatMap((fact) =>
      fact.status === "satisfied" ? fact.evidenceRefs : [],
    ),
  );
  const verifiedTargets: string[] = [];
  const missingTargets: string[] = [];
  for (const [target, mutation] of latestMutationByTarget) {
    const hasSatisfiedFact = satisfiedEvidenceRefs.has(mutation.evidenceRef);
    const hasLaterObservation = snapshot.evidence.some(
      (evidence, index) =>
        index > mutation.index &&
        evidence.outcome === "succeeded" &&
        evidence.effect === "observation" &&
        evidenceTargets(evidence).includes(target),
    );
    (hasSatisfiedFact || hasLaterObservation
      ? verifiedTargets
      : missingTargets
    ).push(target);
  }

  return Object.freeze({
    required: true,
    complete: missingTargets.length === 0,
    mutationTargetCount: latestMutationByTarget.size,
    verifiedTargets: Object.freeze(verifiedTargets),
    missingTargets: Object.freeze(missingTargets),
  });
}

function evidenceTargets(
  evidence: ReviewerReviewSnapshot["evidence"][number],
): string[] {
  return [...new Set((evidence.references ?? []).map(({ target }) => target))];
}
