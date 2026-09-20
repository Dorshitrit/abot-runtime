import type { RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
import { traceDebug } from "../../observability/debug-logger.js";
import {
  readAuditorAdvisoryReceipt,
  type AuditorAdvisoryReceipt,
} from "./advisory-receipt.js";
import {
  EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID,
  parseExecutionAgentAuditObjective,
  type AuditorCapabilityEvidence,
} from "./contracts.js";
import {
  fingerprintAuditorBundle,
  fingerprintAuditorWork,
  projectAuditorWorkEvidence,
} from "./evidence-inventory.js";

export type AuditorInputState = Readonly<{
  available: boolean;
  reason: string;
  workFingerprint: string;
  pendingEvidenceIds: readonly string[] | null;
  reviewedBundleFingerprints: readonly string[];
  reviewedEvidenceBundles: readonly (readonly string[])[];
  reviewedBundleCount: number;
}>;

export function projectAuditorInputState(
  head: RoleCallLedgerHead,
  callerCallId: string,
  steeringVersion: number,
  criterionIds: readonly string[] = [EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID],
  suppliedEvidence?: readonly AuditorCapabilityEvidence[],
): AuditorInputState {
  const evidence =
    suppliedEvidence ?? projectAuditorWorkEvidence(head, callerCallId);
  const workFingerprint = fingerprintAuditorWork({
    requestId: head.state.requestId,
    callerCallId,
    steeringVersion,
    criterionIds,
    evidence,
  });
  const receipts = matchingReceipts(
    head,
    callerCallId,
    workFingerprint,
    steeringVersion,
    criterionIds,
  );
  const reviewedBundleFingerprints = Object.freeze(
    receipts.flatMap((receipt) =>
      receipt.evidenceBinding.bundleFingerprint
        ? [receipt.evidenceBinding.bundleFingerprint]
        : [],
    ),
  );
  const eligibility = auditInputEligibility(
    evidence,
    receipts,
    workFingerprint,
    reviewedBundleFingerprints,
  );
  const state = Object.freeze({
    ...eligibility,
    workFingerprint,
    reviewedBundleFingerprints,
    reviewedEvidenceBundles: Object.freeze(
      receipts
        .filter((receipt) => receipt.evidenceBinding.bundleFingerprint !== null)
        .map((receipt) =>
          Object.freeze([...receipt.evidenceBinding.selectedEvidenceIds]),
        ),
    ),
    reviewedBundleCount: reviewedBundleFingerprints.length,
  });
  traceDebug("runtime.auditor", "input.availability", {
    requestId: head.state.requestId,
    callId: callerCallId,
    phase: "availability",
    workFingerprint,
    inventoryCount: evidence.length,
    available: state.available,
    reason: state.reason,
    reviewedBundleCount: state.reviewedBundleCount,
    pendingEvidenceCount: state.pendingEvidenceIds?.length ?? 0,
  });
  return state;
}

function auditInputEligibility(
  evidence: readonly AuditorCapabilityEvidence[],
  receipts: readonly AuditorAdvisoryReceipt[],
  workFingerprint: string,
  reviewed: readonly string[],
): Pick<AuditorInputState, "available" | "reason" | "pendingEvidenceIds"> {
  if (evidence.length === 0) return unavailable("no_work_evidence");
  if (receipts.some((receipt) => receipt.verdict !== "needs_evidence")) {
    return unavailable("audit_finished_for_work");
  }
  const latest = receipts.at(-1);
  if (!latest)
    return { available: true, reason: "new_work", pendingEvidenceIds: null };
  const requested = latest.requestedEvidenceIds;
  if (!isAvailableEvidenceBundle(requested, evidence))
    return unavailable("requested_evidence_unavailable");
  if (reviewed.includes(fingerprintAuditorBundle(workFingerprint, requested))) {
    return unavailable("requested_bundle_already_reviewed");
  }
  return {
    available: true,
    reason: "auditor_requested_evidence",
    pendingEvidenceIds: Object.freeze([...requested]),
  };
}

function isAvailableEvidenceBundle(
  ids: readonly string[],
  evidence: readonly AuditorCapabilityEvidence[],
): boolean {
  if (ids.length === 0 || new Set(ids).size !== ids.length) return false;
  const knownIds = new Set(evidence.map((entry) => entry.executionId));
  return ids.every((id) => knownIds.has(id));
}

function matchingReceipts(
  head: RoleCallLedgerHead,
  callerCallId: string,
  fingerprint: string,
  steeringVersion: number,
  criterionIds: readonly string[],
): readonly AuditorAdvisoryReceipt[] {
  const receipts: AuditorAdvisoryReceipt[] = [];
  for (const result of head.state.results) {
    if (result.roleId !== "reviewer") continue;
    const producer = head.state.calls.find(
      (call) => call.callId === result.producerCallId,
    );
    if (producer?.parentCallId !== callerCallId || !producer.objective)
      continue;
    if (
      !hasMatchingAuditObjective(
        producer.objective,
        steeringVersion,
        criterionIds,
      )
    )
      continue;
    const receipt = readAuditorAdvisoryReceipt(result.summary);
    if (!receipt || receipt.auditId !== producer.callId) continue;
    if (receipt.evidenceBinding.workFingerprint !== fingerprint) continue;
    receipts.push(receipt);
  }
  return Object.freeze(receipts);
}

function hasMatchingAuditObjective(
  encoded: string,
  steeringVersion: number,
  criterionIds: readonly string[],
): boolean {
  try {
    const objective = parseExecutionAgentAuditObjective(encoded);
    if (objective.requestSteeringVersion !== steeringVersion) return false;
    return (
      JSON.stringify([...objective.criterionIds].sort()) ===
      JSON.stringify([...criterionIds].sort())
    );
  } catch {
    return false;
  }
}

function unavailable(reason: string) {
  return { available: false, reason, pendingEvidenceIds: null } as const;
}
