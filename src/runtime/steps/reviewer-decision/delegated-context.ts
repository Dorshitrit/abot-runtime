import {
  projectRoleCallDependencyResults,
  type RoleCallFrame,
  type RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import {
  REVIEWER_ITEM_SUMMARY_MAX_LENGTH,
  type ReviewerFact,
  type ReviewerSubject,
} from "./contracts.js";

export type ReviewerDelegatedContextProjection = Readonly<{
  subjects: readonly ReviewerSubject[];
  facts: readonly ReviewerFact[];
  subjectBindings: readonly Readonly<{
    callId: string;
    subjectRef: string;
  }>[];
  scopedTopLevelCallIds: readonly string[];
  excludedReviewerCallIds: readonly string[];
  projectionComplete: boolean;
}>;

/**
 * Projects only the exact canonical dependency results attached to the active
 * Reviewer call. The projection describes prior work without granting it
 * user-intent, routing, verdict, or completion authority.
 */
export function projectReviewerDelegatedContext(
  params: Readonly<{
    head: RoleCallLedgerHead;
    reviewer: RoleCallFrame;
    subjectCapacity: number;
    factCapacity: number;
  }>,
): ReviewerDelegatedContextProjection {
  const dependencies = projectRoleCallDependencyResults(
    params.head,
    params.reviewer,
  );
  const subjects: ReviewerSubject[] = [];
  const facts: ReviewerFact[] = [];
  const subjectBindings: { callId: string; subjectRef: string }[] = [];
  const scopedTopLevelCallIds: string[] = [];
  const excludedReviewerCallIds: string[] = [];
  let projectionComplete = true;

  for (const dependency of dependencies) {
    const producer = params.head.state.calls.find(
      ({ callId }) => callId === dependency.producerCallId,
    );
    if (!producer) throw new Error("reviewer_dependency_producer_missing");
    scopedTopLevelCallIds.push(producer.callId);
    if (producer.roleId === "reviewer") {
      excludedReviewerCallIds.push(producer.callId);
    }

    const subjectRef = `call:${producer.callId}`;
    const objective = producer.objective ?? `${producer.roleId} work`;
    projectionComplete =
      !isSummaryTruncated(objective) && projectionComplete;
    if (subjects.length >= params.subjectCapacity) {
      projectionComplete = false;
      continue;
    }
    subjects.push({
      subjectRef,
      kind: `${producer.roleId}_result`,
      summary: boundedSummary(objective),
    });
    subjectBindings.push({ callId: producer.callId, subjectRef });

    projectionComplete =
      !isSummaryTruncated(dependency.summary) && projectionComplete;
    if (facts.length >= params.factCapacity) {
      projectionComplete = false;
      continue;
    }
    facts.push({
      factRef: dependency.resultRef,
      kind: "role_result",
      status:
        dependency.outcome === "completed" ? "informational" : "missing",
      subjectRefs: Object.freeze([subjectRef]),
      evidenceRefs: Object.freeze([]),
      summary: boundedSummary(dependency.summary),
    });
  }

  return Object.freeze({
    subjects: Object.freeze(subjects),
    facts: Object.freeze(facts),
    subjectBindings: Object.freeze(subjectBindings),
    scopedTopLevelCallIds: Object.freeze(scopedTopLevelCallIds),
    excludedReviewerCallIds: Object.freeze(excludedReviewerCallIds),
    projectionComplete,
  });
}

function boundedSummary(value: string): string {
  const normalized = value.trim();
  return normalized.length <= REVIEWER_ITEM_SUMMARY_MAX_LENGTH
    ? normalized
    : normalized.slice(0, REVIEWER_ITEM_SUMMARY_MAX_LENGTH);
}

function isSummaryTruncated(value: string): boolean {
  return value.trim().length > REVIEWER_ITEM_SUMMARY_MAX_LENGTH;
}
