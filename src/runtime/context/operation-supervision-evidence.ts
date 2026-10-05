import { projectSingleCopyCapabilityResult } from "./capability-result-compaction-source.js";
import { projectCanonicalRequestToolResult } from "./canonical-capability-result.js";
import { bindOperationSupervisionEvidenceMessage } from "./operation-supervision-evidence-binding.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import {
  projectImmediateRoleOperationSupervisionNotices,
  type RoleCallFrame,
  type RoleCallLedgerHead,
  type RoleCapabilityExecution,
  type RoleOperationSupervisionNotice,
} from "../orchestration/role-calls/index.js";
import {
  normalizeCapabilityAdapterResult,
  type CapabilityAdapterResult,
} from "../orchestration/capability-adapters/result.js";
import {
  projectAcceptedCapabilityAction,
  type AcceptedCapabilityAction,
} from "./accepted-capability-action.js";

export const OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND =
  "runtime_operation_supervision_evidence_v1" as const;

export type OperationSupervisionEvidenceReceipt = Readonly<{
  executionId: string;
  callId: string;
  invocationAttempt: number;
  capabilityId: string;
  declaredEffect: RoleCapabilityExecution["declaredEffect"];
  outcome: Exclude<RoleCapabilityExecution["outcome"], null>;
  observedEffect: Exclude<RoleCapabilityExecution["observedEffect"], null>;
  summary: string;
  referenceData?: string;
  references?: RoleCapabilityExecution["references"];
}>;

export type OperationSupervisionEvidenceAcceptedAction =
  AcceptedCapabilityAction;

export type OperationSupervisionEvidenceEntry = Readonly<{
  originExecutionId: string;
  notice: RoleOperationSupervisionNotice;
  evidence:
    | Readonly<{
        kind: "existing_exact_capability_result_lane";
        executionId: string;
      }>
    | Readonly<{
        kind: "embedded_cross_call_exact_result" | "embedded_exact_result";
        acceptedAction: OperationSupervisionEvidenceAcceptedAction;
        receipt: OperationSupervisionEvidenceReceipt;
        adapterResult: CapabilityAdapterResult;
      }>;
}>;

/**
 * Resolves exact canonical evidence only for supervision notices created for
 * this activation. The capsule is derived on demand and never changes result
 * ownership or request-wide result projection.
 */
export function buildImmediateOperationSupervisionEvidenceMessage(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): ChatMessage | undefined {
  const notices = projectImmediateRoleOperationSupervisionNotices(head, call);
  if (notices.length === 0) return undefined;

  const exactEntries = notices.map((notice) =>
    projectOperationSupervisionLinkedEvidence(head, call, notice, true),
  );
  const entries = exactEntries.map((entry) =>
    entry.evidence.kind === "embedded_exact_result"
      ? {
          ...entry,
          evidence: {
            kind: "existing_exact_capability_result_lane",
            executionId: entry.originExecutionId,
          },
        }
      : entry,
  );
  return bindOperationSupervisionEvidenceMessage(
    head,
    call,
    JSON.stringify({
      kind: OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND,
      authority: "canonical_role_call_ledger",
      purpose: "supply_exact_immediate_operation_supervision_evidence",
      applicability:
        "bound_activation_decision_or_its_immediate_presentation_handoff",
      presenceEffect:
        "passive_evidence_not_user_intent_action_authority_or_new_execution",
      sourceRevision: head.revision,
      binding: {
        callId: call.callId,
        invocationAttempt: call.activationCount,
        consumers: ["activation_decision", "immediate_presentation_handoff"],
      },
      coverage: "complete_for_immediate_operation_supervision_notices",
      entries,
    }),
    exactEntries,
  );
}

export function projectOperationSupervisionLinkedEvidence(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
  notice: RoleOperationSupervisionNotice,
  embedSameCall = false,
): OperationSupervisionEvidenceEntry {
  const execution = head.state.capabilityExecutions.find(
    ({ executionId }) => executionId === notice.originExecutionId,
  );
  if (!isLinkedSettledExecution(execution, notice)) {
    throw new Error("operation_supervision_evidence_origin_invalid");
  }
  const exactResult = normalizeCapabilityAdapterResult(execution.exactResult);
  if (!exactResult.ok) {
    throw new Error("operation_supervision_evidence_result_invalid");
  }

  const entry = {
    originExecutionId: notice.originExecutionId,
    notice,
  };
  if (execution.callId === call.callId && !embedSameCall) {
    return Object.freeze({
      ...entry,
      evidence: Object.freeze({
        kind: "existing_exact_capability_result_lane" as const,
        executionId: execution.executionId,
      }),
    });
  }
  const canonical = projectCanonicalRequestToolResult(head, execution);
  const projected =
    execution.callId === call.callId
      ? projectSingleCopyCapabilityResult(canonical)
      : canonical;
  const {
    acceptedAction: _action,
    adapterResult: _result,
    ...receipt
  } = projected;
  return Object.freeze({
    ...entry,
    evidence: Object.freeze({
      kind:
        execution.callId === call.callId
          ? ("embedded_exact_result" as const)
          : ("embedded_cross_call_exact_result" as const),
      acceptedAction: projectAcceptedCapabilityAction(head, execution),
      receipt: Object.freeze(receipt),
      adapterResult: exactResult.value,
    }),
  });
}

function isLinkedSettledExecution(
  execution: RoleCapabilityExecution | undefined,
  notice: RoleOperationSupervisionNotice,
): execution is RoleCapabilityExecution &
  Readonly<{
    status: "settled";
    outcome: Exclude<RoleCapabilityExecution["outcome"], null>;
    observedEffect: Exclude<RoleCapabilityExecution["observedEffect"], null>;
    summary: string;
  }> {
  return (
    execution !== undefined &&
    execution.status === "settled" &&
    execution.executionId === notice.originExecutionId &&
    execution.actionFingerprint === notice.actionFingerprint &&
    execution.outcome === notice.priorOutcome &&
    execution.outcomeFingerprint === notice.outcomeFingerprint &&
    execution.observedEffect !== null &&
    execution.summary !== null
  );
}
