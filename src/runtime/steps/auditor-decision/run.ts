import {
  invokeStructuredModelStep,
  StructuredModelInvalidOutputError,
  type StructuredModelParseResult,
} from "../../model/invoke-structured-step.js";
import type { RoleExecutor } from "../../orchestration/role-executors/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import type { RequestRoleExecutionHandoff } from "../../request/result.js";
import { traceDebug } from "../../observability/debug-logger.js";
import {
  parseExecutionAgentAuditObjective,
  type AuditorAssignment,
} from "./contracts.js";
import { buildAuditorDecisionInput } from "./input.js";
import { parseAuditorDecisionOutput } from "./parser.js";
import { projectAuditorAssignment } from "./projection.js";
import { projectAuditorInputState } from "./audit-input-state.js";
import {
  projectAuditorWorkEvidence,
  fingerprintAuditorBundle,
} from "./evidence-inventory.js";
import {
  bindAuditorEvidence,
  AuditorEvidenceAdmissionError,
} from "./evidence-binding.js";
import { parseAuditorEvidenceSelection } from "./evidence-selection.js";
import { projectAuditorEvidenceRepresentation } from "./evidence-representation.js";
import {
  failedAuditorAdvisory,
  settleAuditorAdvisory,
} from "./advisory-receipt.js";

import { AuditorAdvisoryCapacityError } from "./advisory-result-budget.js";

export const EXECUTION_AGENT_AUDITOR_EXECUTOR: RoleExecutor<
  RequestExecutionScope,
  RequestRoleExecutionHandoff
> = Object.freeze({
  roleId: "reviewer",
  async execute({ context, call, ledger, continuation }) {
    const head = ledger.current();
    let assignment = projectAuditorAssignment(context, head, call);
    if (continuation)
      return failedAuditorAdvisory(
        assignment,
        "auditor_continuation_unsupported",
      );
    const objective = parseExecutionAgentAuditObjective(call.objective!);
    const source = projectAuditorWorkEvidence(head, assignment.callerCallId);
    const state = projectAuditorInputState(
      head,
      assignment.callerCallId,
      objective.requestSteeringVersion,
      objective.criterionIds,
      source,
    );
    if (!state.available)
      return failedAuditorAdvisory(assignment, state.reason);
    try {
      const selectedIds =
        assignment.pendingEvidenceIds ??
        (
          await invokeAuditorPhase(
            context,
            buildAuditorDecisionInput(context, assignment, "selection"),
            (text) => parseAuditorEvidenceSelection(text, assignment),
          )
        ).selectedEvidenceIds;
      assignment = bindAuditorEvidence(assignment, source, selectedIds);
      const decision = await invokeAuditorPhase(
        context,
        buildAuditorDecisionInput(context, assignment, "review"),
        (text) => parseAuditorDecisionOutput(text, assignment),
      );
      traceDebug("runtime.auditor", "review.completed", {
        requestId: context.requestId,
        callId: call.callId,
        phase: "review",
        workFingerprint: assignment.workFingerprint,
        bundleFingerprint: fingerprintAuditorBundle(
          assignment.workFingerprint,
          selectedIds,
        ),
        verdict: decision.verdict,
        requestedEvidenceIds: decision.requestedEvidenceIds,
        requestedEvidenceCount: decision.requestedEvidenceIds.length,
      });
      return settleAuditorAdvisory(assignment, decision);
    } catch (error: unknown) {
      const reason = auditorFailureReason(error);
      if (!reason) throw error;
      traceDebug("runtime.auditor", "evidence.rejected", {
        requestId: context.requestId,
        callId: call.callId,
        phase:
          assignment.selectedEvidenceIds.length > 0 ? "review" : "selection",
        workFingerprint: assignment.workFingerprint,
        selectedEvidenceCount: assignment.selectedEvidenceIds.length,
        reason,
      });
      return failedAuditorAdvisory(assignment, reason);
    }
  },
});

async function invokeAuditorPhase<T>(
  request: RequestExecutionScope,
  input: ReturnType<typeof buildAuditorDecisionInput>,
  parse: (text: string) => StructuredModelParseResult<T>,
): Promise<T> {
  traceDebug("runtime.auditor", "phase.started", {
    requestId: request.requestId,
    callId: input.assignment.auditId,
    phase: input.phase,
    workFingerprint: input.assignment.workFingerprint,
    inventoryCount: input.assignment.inventory.length,
    selectedEvidenceIds: input.assignment.selectedEvidenceIds,
    selectedEvidenceCount: input.assignment.evidence.length,
    selectedEvidenceChars: input.assignment.evidence.reduce(
      (total, entry) =>
        total +
        JSON.stringify(projectAuditorEvidenceRepresentation(entry)).length,
      0,
    ),
    canonicalEvidenceChars: input.assignment.evidence.reduce(
      (total, entry) => total + JSON.stringify(entry).length,
      0,
    ),
  });
  return invokeStructuredModelStep({
    request,
    modelStep: input.modelStep,
    format: input.format,
    messages: input.context.messages,
    contextRetention: "exact",
    timeoutReason: "auditor_decision_timeout",
    invalidOutputReason: "invalid_auditor_decision",
    parse,
  });
}

function auditorFailureReason(error: unknown): string | undefined {
  if (error instanceof StructuredModelInvalidOutputError)
    return "invalid_auditor_decision";
  if (error instanceof AuditorEvidenceAdmissionError) return error.message;
  if (error instanceof AuditorAdvisoryCapacityError) return error.message;
  if (!(error instanceof Error)) return undefined;
  if (error.message === "request_context_required_content_exceeds_budget")
    return "auditor_exact_context_exceeds_budget";
  if (error.message === "request_context_pinned_content_exceeds_budget")
    return "auditor_exact_context_exceeds_budget";
  if (error.message === "request_context_compaction_required")
    return "auditor_exact_context_requires_compaction";
  if (error.message === "request_context_final_envelope_exceeds_window")
    return "auditor_exact_context_exceeds_budget";
  if (error.message === "model_context_window_exceeded")
    return "auditor_exact_context_exceeds_budget";
  return undefined;
}
