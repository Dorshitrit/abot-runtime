import type {
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import {
  SEMANTIC_COMPACTION_CONTEXT_LANE,
  createSemanticCompactionSha256Fingerprint,
  isSemanticCompactionCheckpointApplicable,
  type RequestContextCompactionStore,
} from "../../context/semantic-compaction/index.js";
import {
  REVIEWER_COMPLETION_TARGET_MAX_LENGTH,
  REVIEWER_DECISION_MODEL_STEP,
  REVIEWER_MAX_FACTS,
  REVIEWER_MAX_SUBJECTS,
  resolveCanonicalReviewerCompletionTargetText,
  type ReviewerEvidence,
  type ReviewerFact,
  type ReviewerReviewSnapshot,
  type ReviewerSubject,
} from "./contracts.js";
import {
  traceReviewerSnapshotProjected,
  traceReviewerSnapshotRejected,
} from "./diagnostics.js";
import { projectReviewerDelegatedContext } from "./delegated-context.js";
import {
  projectReviewerFinalEvidence,
  type ReviewerEvidenceCandidate,
  type ReviewerFinalEvidenceProjection,
  type ReviewerReferenceDataBudget,
} from "./final-evidence.js";

const REVIEWER_GAP_KINDS = Object.freeze([
  "incomplete_outcome",
  "missing_evidence",
  "missing_artifact",
  "state_mismatch",
  "contradictory_fact",
  "indeterminate_fact",
] as const);

/**
 * Projects the caller's already committed work into one bounded review
 * snapshot. This boundary reports canonical state only; it never infers a
 * verdict or a remediation action.
 */
export function projectReviewerReviewSnapshot(
  params: Readonly<{
    requestId: string;
    requestObjective: string;
    ledger: RoleCallLedger;
    call: RoleCallFrame;
    referenceDataBudget: ReviewerReferenceDataBudget;
    contextCompactionStore?: RequestContextCompactionStore;
    trace?: boolean;
  }>,
): ReviewerReviewSnapshot {
  try {
    const { snapshot, finalEvidence, callerObjectiveSource } =
      projectReviewerReviewSnapshotUnchecked(params);
    if (params.trace !== false) {
      traceReviewerSnapshotProjected({
        requestId: params.requestId,
        call: params.call,
        snapshot,
        finalEvidence,
        callerObjectiveSource,
      });
    }
    return snapshot;
  } catch (error: unknown) {
    if (params.trace !== false) {
      traceReviewerSnapshotRejected({
        requestId: params.requestId,
        call: params.call,
        issueCode:
          error instanceof Error &&
          error.message.startsWith("reviewer_snapshot_")
            ? error.message
            : "reviewer_snapshot_projection_failed",
      });
    }
    throw error;
  }
}

function projectReviewerReviewSnapshotUnchecked(
  params: Readonly<{
    requestId: string;
    requestObjective: string;
    ledger: RoleCallLedger;
    call: RoleCallFrame;
    referenceDataBudget: ReviewerReferenceDataBudget;
    contextCompactionStore?: RequestContextCompactionStore;
    trace?: boolean;
  }>,
): Readonly<{
  snapshot: ReviewerReviewSnapshot;
  finalEvidence: ReviewerFinalEvidenceProjection;
  callerObjectiveSource: "caller_objective" | "request_source";
}> {
  const head = params.ledger.current();
  const reviewer = requireActiveReviewer(head, params.requestId, params.call);
  const caller = head.state.calls.find(
    (candidate) => candidate.callId === reviewer.parentCallId,
  );
  if (
    !caller ||
    caller.status !== "waiting_for_child" ||
    !caller.childCallIds.includes(reviewer.callId)
  ) {
    throw new Error("reviewer_snapshot_caller_invalid");
  }

  let projectionComplete = true;
  const subjects: ReviewerSubject[] = [];
  const facts: ReviewerFact[] = [];
  const evidence: ReviewerEvidence[] = [];
  const evidenceCandidates: ReviewerEvidenceCandidate[] = [];
  const subjectRefByTopLevelCallId = new Map<string, string>();

  const callerObjective = caller.objective ?? params.requestObjective.trim();
  if (!callerObjective) {
    throw new Error("reviewer_snapshot_caller_objective_missing");
  }
  const callerObjectiveSource = caller.objective
    ? "caller_objective"
    : "request_source";
  {
    const callerSubjectRef = `call:${caller.callId}`;
    const unboundedCompletionTarget = callerObjective.trim();
    const completionTarget = resolveCanonicalReviewerCompletionTargetText(
      unboundedCompletionTarget,
    );
    if (
      unboundedCompletionTarget.length > REVIEWER_COMPLETION_TARGET_MAX_LENGTH
    ) {
      projectionComplete = false;
    }
    if (reviewer.objective.trim() !== completionTarget) {
      throw new Error("reviewer_snapshot_completion_target_binding_invalid");
    }
    projectionComplete =
      pushBounded(
        subjects,
        {
          subjectRef: callerSubjectRef,
          kind: "caller_objective",
          summary: completionTarget,
        },
        REVIEWER_MAX_SUBJECTS,
      ) && projectionComplete;
    if (subjects.some(({ subjectRef }) => subjectRef === callerSubjectRef)) {
      subjectRefByTopLevelCallId.set(caller.callId, callerSubjectRef);
    }
  }

  const delegatedContext = projectReviewerDelegatedContext({
    head,
    reviewer,
    subjectCapacity: REVIEWER_MAX_SUBJECTS - subjects.length,
    factCapacity: REVIEWER_MAX_FACTS - facts.length,
  });
  subjects.push(...delegatedContext.subjects);
  facts.push(...delegatedContext.facts);
  projectionComplete =
    delegatedContext.projectionComplete && projectionComplete;
  for (const { callId, subjectRef } of delegatedContext.subjectBindings) {
    subjectRefByTopLevelCallId.set(callId, subjectRef);
  }
  const scopedTopLevelCallIds = new Set([
    caller.callId,
    ...delegatedContext.scopedTopLevelCallIds,
  ]);
  const excludedReviewerCallIds = new Set(
    delegatedContext.excludedReviewerCallIds,
  );
  const compactedReferenceDataByExecutionId =
    projectReviewerCompactedReferenceData({
      requestId: params.requestId,
      requestObjective: params.requestObjective,
      head,
      callerCallId: caller.callId,
      reviewerCallId: reviewer.callId,
      scopedTopLevelCallIds,
      store: params.contextCompactionStore,
    });

  for (const execution of head.state.capabilityExecutions) {
    const topLevelCallId = resolveTopLevelScopeCallId(
      head,
      caller.callId,
      reviewer.callId,
      execution.callId,
    );
    if (!topLevelCallId) continue;
    if (!scopedTopLevelCallIds.has(topLevelCallId)) continue;
    if (excludedReviewerCallIds.has(topLevelCallId)) continue;
    if (
      execution.status !== "settled" ||
      !execution.outcome ||
      !execution.observedEffect ||
      !execution.summary
    ) {
      projectionComplete = false;
      continue;
    }
    const subjectRef = subjectRefByTopLevelCallId.get(topLevelCallId);
    if (!subjectRef) {
      projectionComplete = false;
      continue;
    }
    const compactedReferenceData = compactedReferenceDataByExecutionId.get(
      execution.executionId,
    );
    evidenceCandidates.push(
      Object.freeze({
        executionId: execution.executionId,
        outcome: execution.outcome,
        observedEffect: execution.observedEffect,
        summary: execution.summary,
        ...(compactedReferenceData
          ? { referenceData: compactedReferenceData }
          : execution.referenceData
            ? { referenceData: execution.referenceData }
            : {}),
        ...(execution.references
          ? { references: Object.freeze([...execution.references]) }
          : {}),
        subjectRef,
      }),
    );
  }

  const finalEvidence = projectReviewerFinalEvidence(
    evidenceCandidates,
    params.referenceDataBudget,
  );
  evidence.push(...finalEvidence.evidence);
  projectionComplete = finalEvidence.projectionComplete && projectionComplete;

  const snapshot: ReviewerReviewSnapshot = deepFreeze({
    reviewScopeId: `review:${reviewer.callId}:r${head.revision}`,
    reviewerCallId: reviewer.callId,
    callerCallId: caller.callId,
    sourceRevision: head.revision,
    projectionComplete,
    freshness: "current",
    allowedGapKinds: REVIEWER_GAP_KINDS,
    subjects,
    facts,
    evidence,
  });
  return Object.freeze({ snapshot, finalEvidence, callerObjectiveSource });
}

function projectReviewerCompactedReferenceData(
  params: Readonly<{
    requestId: string;
    requestObjective: string;
    head: RoleCallLedgerHead;
    callerCallId: string;
    reviewerCallId: string;
    scopedTopLevelCallIds: ReadonlySet<string>;
    store?: RequestContextCompactionStore;
  }>,
): ReadonlyMap<string, string> {
  if (!params.store) return new Map();
  const store = params.store;
  const callsById = new Map(
    params.head.state.calls.map((call) => [call.callId, call] as const),
  );
  const currentRequestFingerprint = createSemanticCompactionSha256Fingerprint(
    params.requestObjective,
  );
  const callIds = [
    ...new Set(
      params.head.state.capabilityExecutions.map(({ callId }) => callId),
    ),
  ].filter((callId) => {
    const topLevelCallId = resolveTopLevelScopeCallId(
      params.head,
      params.callerCallId,
      params.reviewerCallId,
      callId,
    );
    return (
      topLevelCallId !== undefined &&
      params.scopedTopLevelCallIds.has(topLevelCallId)
    );
  });
  const projected = new Map<string, string>();
  for (const checkpoint of store.findByCallIds(callIds)) {
    const call = callsById.get(checkpoint.callId);
    if (
      !call?.objective ||
      !isSemanticCompactionCheckpointApplicable(checkpoint, {
        requestId: params.requestId,
        currentRequestFingerprint,
        roleId: call.roleId,
        callId: call.callId,
        objectiveFingerprint: createSemanticCompactionSha256Fingerprint(
          call.objective,
        ),
        contextLane: SEMANTIC_COMPACTION_CONTEXT_LANE,
        consumer: REVIEWER_DECISION_MODEL_STEP,
      })
    ) {
      continue;
    }
    for (const digest of checkpoint.sourceDigests) {
      if (
        !store.materializeSource(digest.sourceRef, digest.sourceFingerprint) ||
        projected.has(digest.sourceRef)
      ) {
        throw new Error("reviewer_compacted_evidence_binding_invalid");
      }
      projected.set(
        digest.sourceRef,
        JSON.stringify({
          kind: "runtime_reviewer_compacted_evidence_v1",
          authority: "runtime_semantic_compaction_checkpoint",
          purpose: "reviewer_evidence_projection",
          presenceEffect:
            "passive_evidence_not_user_intent_routing_or_completion",
          checkpoint: {
            scopeId: checkpoint.scopeId,
            sourceRevision: checkpoint.sourceRevision,
          },
          source: {
            sourceRef: digest.sourceRef,
            sourceFingerprint: digest.sourceFingerprint,
            digest: digest.digest,
          },
        }),
      );
    }
  }
  return projected;
}

function requireActiveReviewer(
  head: RoleCallLedgerHead,
  requestId: string,
  supplied: RoleCallFrame,
): RoleCallFrame & Readonly<{ parentCallId: string; objective: string }> {
  const canonical = head.state.calls.find(
    (candidate) => candidate.callId === supplied.callId,
  );
  if (
    head.state.requestId !== requestId ||
    head.state.phase !== "running" ||
    head.state.activeCallId !== supplied.callId ||
    canonical !== supplied ||
    canonical.roleId !== "reviewer" ||
    canonical.parentCallId === null ||
    canonical.status !== "active" ||
    !canonical.objective ||
    canonical.activationCount !== 1 ||
    canonical.resultRef !== null
  ) {
    throw new Error("reviewer_snapshot_authority_invalid");
  }
  return canonical as RoleCallFrame &
    Readonly<{ parentCallId: string; objective: string }>;
}

function resolveTopLevelScopeCallId(
  head: RoleCallLedgerHead,
  callerCallId: string,
  reviewerCallId: string,
  executionCallId: string,
): string | undefined {
  let current = head.state.calls.find(
    (candidate) => candidate.callId === executionCallId,
  );
  const visited = new Set<string>();
  while (current && !visited.has(current.callId)) {
    visited.add(current.callId);
    if (current.callId === reviewerCallId) return undefined;
    if (current.callId === callerCallId) return callerCallId;
    if (current.parentCallId === callerCallId) return current.callId;
    current = current.parentCallId
      ? head.state.calls.find(
          (candidate) => candidate.callId === current!.parentCallId,
        )
      : undefined;
  }
  return undefined;
}

function pushBounded<T>(target: T[], value: T, maximum: number): boolean {
  if (target.length >= maximum) return false;
  target.push(value);
  return true;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
