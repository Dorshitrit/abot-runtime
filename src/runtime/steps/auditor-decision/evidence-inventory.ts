import { createHash } from "node:crypto";
import type {
  RoleCallLedgerHead,
  RoleCapabilityExecution,
} from "../../orchestration/role-calls/index.js";
import type {
  AuditorCapabilityEvidence,
  AuditorEvidenceInventoryEntry,
  AuditorEvidencePreview,
} from "./contracts.js";
import { projectAuditorEvidenceRepresentation } from "./evidence-representation.js";

const INVENTORY_PREVIEW_MAX_CHARS = 160;
const INVENTORY_TARGET_PREVIEW_LIMIT = 2;

export function projectAuditorWorkEvidence(
  head: RoleCallLedgerHead,
  callerCallId: string,
): readonly AuditorCapabilityEvidence[] {
  return Object.freeze(
    rootSettledExecutions(head, callerCallId).map(projectCapabilityEvidence),
  );
}

export function projectAuditorEvidenceInventory(
  head: RoleCallLedgerHead,
  callerCallId: string,
  evidence: readonly AuditorCapabilityEvidence[],
): readonly AuditorEvidenceInventoryEntry[] {
  const executions = rootSettledExecutions(head, callerCallId);
  return Object.freeze(
    evidence.map((entry, index) => {
      const execution = executions[index]!;
      const references = entry.references ?? [];
      return Object.freeze({
        executionId: entry.executionId,
        callId: execution.callId,
        invocationAttempt: execution.invocationAttempt,
        capabilityId: entry.capabilityId,
        declaredEffect: entry.declaredEffect,
        outcome: entry.outcome,
        observedEffect: entry.observedEffect,
        summaryPreview: preview(entry.summary),
        targetPreviews: Object.freeze(
          references
            .slice(0, INVENTORY_TARGET_PREVIEW_LIMIT)
            .map(({ target }) => preview(target)),
        ),
        referenceCount: references.length,
        omittedReferencePreviewCount: Math.max(
          0,
          references.length - INVENTORY_TARGET_PREVIEW_LIMIT,
        ),
        exactEvidenceChars: JSON.stringify(
          projectAuditorEvidenceRepresentation(entry),
        ).length,
        evidenceFingerprint: fingerprintAuditorEvidence(entry),
      });
    }),
  );
}

export function fingerprintAuditorWork(
  params: Readonly<{
    requestId: string;
    callerCallId: string;
    steeringVersion: number;
    criterionIds: readonly string[];
    evidence: readonly AuditorCapabilityEvidence[];
  }>,
): string {
  return fingerprint(
    JSON.stringify({
      ...params,
      criterionIds: [...params.criterionIds].sort(),
    }),
  );
}

export function fingerprintAuditorBundle(
  workFingerprint: string,
  selectedEvidenceIds: readonly string[],
): string {
  return fingerprint(
    JSON.stringify({
      workFingerprint,
      selectedEvidenceIds: [...selectedEvidenceIds].sort(),
    }),
  );
}

export function fingerprintAuditorEvidence(
  evidence: AuditorCapabilityEvidence,
): string {
  return fingerprint(JSON.stringify(evidence));
}

function rootSettledExecutions(
  head: RoleCallLedgerHead,
  callerCallId: string,
): readonly RoleCapabilityExecution[] {
  return head.state.capabilityExecutions.filter(
    (execution) =>
      execution.callId === callerCallId && execution.status === "settled",
  );
}

function projectCapabilityEvidence(
  execution: RoleCapabilityExecution,
): AuditorCapabilityEvidence {
  if (!hasSettledEvidence(execution)) {
    throw new Error("execution_agent_auditor_evidence_invalid");
  }
  return Object.freeze({
    kind: "capability_result" as const,
    executionId: execution.executionId,
    capabilityId: execution.capabilityId,
    declaredEffect: execution.declaredEffect,
    outcome: execution.outcome!,
    observedEffect: execution.observedEffect!,
    summary: execution.summary!,
    ...(execution.referenceData !== undefined
      ? { referenceData: execution.referenceData }
      : {}),
    ...(execution.references !== undefined
      ? { references: execution.references }
      : {}),
    adapterResult: execution.exactResult!,
  });
}

function hasSettledEvidence(execution: RoleCapabilityExecution): boolean {
  if (execution.status !== "settled") return false;
  if (execution.outcome === null || execution.observedEffect === null)
    return false;
  if (execution.summary === null) return false;
  return execution.exactResult !== undefined;
}

function preview(text: string): AuditorEvidencePreview {
  return Object.freeze({
    text: text.slice(0, INVENTORY_PREVIEW_MAX_CHARS),
    originalChars: text.length,
    truncated: text.length > INVENTORY_PREVIEW_MAX_CHARS,
  });
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
