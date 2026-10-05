import type {
  RoleCallFrame,
  RoleCallLedgerHead,
  RoleCapabilityExecution,
} from "../../orchestration/role-calls/index.js";
import type { RoleOperationSupervisionNotice } from "../../orchestration/role-calls/operation-supervision-projection.js";
import {
  OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND,
  projectOperationSupervisionLinkedEvidence,
} from "../operation-supervision-evidence.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionSource,
} from "./contracts.js";
import { readStoredSourceMessage } from "./super-source-message.js";

/** Historical notices bind to immutable executions, never today's transient warning state. */
export function assertHistoricalOperationSource(params: {
  source: SemanticCompactionSource;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
}): void {
  const { source, head, call } = params;
  const message = readStoredSourceMessage(source);
  const record = JSON.parse(message.content);
  if (call.roleId !== "worker")
    throw new Error("context_compaction_source_family_not_owned");
  if (record.kind !== OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND)
    throw new Error("context_compaction_supervision_source_invalid");
  if (
    source.sourceRef !==
    `operation-supervision-evidence:${hash(message.content).slice(7)}`
  )
    throw new Error("context_compaction_supervision_source_invalid");
  const invocation = record.binding?.invocationAttempt;
  if (record.binding?.callId !== call.callId)
    throw new Error("context_compaction_supervision_call_invalid");
  if (
    !Number.isSafeInteger(invocation) ||
    invocation < 2 ||
    invocation > call.activationCount
  )
    throw new Error("context_compaction_supervision_invocation_invalid");
  if (
    !Number.isSafeInteger(record.sourceRevision) ||
    record.sourceRevision > head.revision ||
    record.sourceRevision < 1
  )
    throw new Error("context_compaction_supervision_revision_invalid");
  if (!Array.isArray(record.entries) || record.entries.length === 0)
    throw new Error("context_compaction_supervision_source_invalid");
  const entries = record.entries.map(
    (entry: { originExecutionId?: unknown; notice?: unknown }) => {
      const notice = requireHistoricalNotice(entry.notice);
      if (entry.originExecutionId !== notice.originExecutionId)
        throw new Error("context_compaction_supervision_origin_invalid");
      const execution = head.state.capabilityExecutions.find(
        (candidate) => candidate.executionId === notice.originExecutionId,
      );
      if (!execution)
        throw new Error("context_compaction_supervision_origin_invalid");
      if (
        !isHistoricalNoticeInvocationBound(notice, execution, call, invocation)
      )
        throw new Error("context_compaction_supervision_invocation_invalid");
      return projectOperationSupervisionLinkedEvidence(head, call, notice);
    },
  );
  const expected = {
    kind: OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND,
    authority: "canonical_role_call_ledger",
    purpose: "supply_exact_immediate_operation_supervision_evidence",
    applicability:
      "bound_activation_decision_or_its_immediate_presentation_handoff",
    presenceEffect:
      "passive_evidence_not_user_intent_action_authority_or_new_execution",
    sourceRevision: record.sourceRevision,
    binding: {
      callId: call.callId,
      invocationAttempt: invocation,
      consumers: ["activation_decision", "immediate_presentation_handoff"],
    },
    coverage: "complete_for_immediate_operation_supervision_notices",
    entries,
  };
  if (JSON.stringify(record) !== JSON.stringify(expected))
    throw new Error("context_compaction_supervision_evidence_changed");
}

function requireHistoricalNotice(
  value: unknown,
): RoleOperationSupervisionNotice {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("context_compaction_supervision_notice_invalid");
  const keys = Object.keys(value);
  const permittedKeys = [
    "kind",
    "authority",
    "presenceEffect",
    "stage",
    "actionFingerprint",
    "priorOutcome",
    "outcomeFingerprint",
    "originExecutionId",
    "matchingOutcomeCount",
    "interventionCount",
  ];
  if (
    keys.length !== permittedKeys.length ||
    keys.some((key) => !permittedKeys.includes(key))
  )
    throw new Error("context_compaction_supervision_notice_invalid");
  const notice = value as RoleOperationSupervisionNotice;
  if (notice.kind !== "runtime_operation_supervision_v1")
    throw new Error("context_compaction_supervision_notice_invalid");
  if (notice.authority !== "runtime_state")
    throw new Error("context_compaction_supervision_notice_invalid");
  if (
    notice.presenceEffect !== "passive_mechanical_intervention_not_user_intent"
  )
    throw new Error("context_compaction_supervision_notice_invalid");
  if (notice.stage !== "warning" && notice.stage !== "intervention")
    throw new Error("context_compaction_supervision_notice_invalid");
  if (notice.matchingOutcomeCount !== 2)
    throw new Error("context_compaction_supervision_notice_invalid");
  if (notice.interventionCount !== (notice.stage === "warning" ? 0 : 1))
    throw new Error("context_compaction_supervision_notice_invalid");
  return notice;
}

function isHistoricalNoticeInvocationBound(
  notice: RoleOperationSupervisionNotice,
  execution: RoleCapabilityExecution,
  call: RoleCallFrame,
  invocation: number,
): boolean {
  if (notice.stage === "warning")
    return (
      execution.callId === call.callId &&
      execution.invocationAttempt + 1 === invocation
    );
  if (execution.callId !== call.callId) return true;
  return execution.invocationAttempt < invocation;
}
