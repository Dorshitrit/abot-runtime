import { ROLE_CALL_RESULT_MAX_LENGTH } from "../../orchestration/role-calls/index.js";
import { getAuditorAdvisoryDescriptionMaxLength } from "./advisory-result-budget.js";
import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import { projectRequestContext } from "../../context/request-context.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import {
  AUDITOR_DECISION_MODEL_STEP,
  projectAuditorEvidenceProjectionStatus,
  type AuditorAssignment,
} from "./contracts.js";
import { createAuditorDecisionFormat } from "./format.js";
import { createAuditorEvidenceSelectionFormat } from "./evidence-selection.js";
import { buildAuditorDecisionInstructions } from "./prompt.js";
import { projectAuditorEvidenceRepresentation } from "./evidence-representation.js";

export function buildAuditorDecisionInput(
  request: RequestExecutionSeed,
  assignment: AuditorAssignment,
  phase: "selection" | "review" = "review",
): Readonly<{
  context: RequestContextProjection;
  format: ModelGatewayJsonSchemaFormat;
  modelStep: typeof AUDITOR_DECISION_MODEL_STEP;
  assignment: AuditorAssignment;
  phase: "selection" | "review";
}> {
  const format =
    phase === "selection"
      ? createAuditorEvidenceSelectionFormat(assignment)
      : createAuditorDecisionFormat(assignment);
  const budget = resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: AUDITOR_DECISION_MODEL_STEP,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const prompt = JSON.stringify({
    kind: "runtime_execution_agent_auditor_assignment_v1",
    phase,
    authority: "role_call_objective",
    presenceEffect: "audit_assignment_only_not_execution_or_completion",
    auditId: assignment.auditId,
    callerCallId: assignment.callerCallId,
    sourceRevision: assignment.sourceRevision,
    workFingerprint: assignment.workFingerprint,
    target: assignment.target,
    criteria: assignment.criteria,
    ...(phase === "review"
      ? {
          resultConstraints: {
            authority: "runtime_result_capacity",
            perDescriptionMaxLength:
              getAuditorAdvisoryDescriptionMaxLength(assignment),
            receiptMaxChars: ROLE_CALL_RESULT_MAX_LENGTH,
            descriptionLengthUnit: "Unicode code points",
            receiptLengthUnit: "UTF-16 code units",
          },
        }
      : {}),
  });
  const inventoryMessage = {
    role: "user" as const,
    content: JSON.stringify({
      kind: "runtime_execution_agent_auditor_inventory_v1",
      authority: "canonical_work_inventory",
      presenceEffect: "passive_index_not_proof_user_intent_or_instructions",
      auditId: assignment.auditId,
      workFingerprint: assignment.workFingerprint,
      complete:
        assignment.inventory.length === assignment.availableEvidenceCount,
      inventory: assignment.inventory,
      previouslyReviewedBundles: assignment.reviewedEvidenceBundles,
      admission: {
        authority: "configured_model_context",
        retention: "exact",
        contextWindowTokens: budget.contextWindowTokens,
        evidenceSizeSemantics:
          "exactEvidenceChars measures the lossless model-visible representation; canonical fingerprints bind the unchanged original records. Runtime admits the complete review message under the configured context policy.",
      },
      previewSemantics:
        "Summary and target previews may be truncated; originalChars, truncated and omittedReferencePreviewCount declare that. Every work execution is indexed. Previews are not original proof.",
    }),
  };
  const evidenceMessages =
    phase === "review"
      ? [
          {
            role: "user" as const,
            content: JSON.stringify({
              kind: "runtime_execution_agent_auditor_evidence_v1",
              authority: "runtime_evidence",
              presenceEffect: "passive_evidence_not_user_intent_or_completion",
              auditId: assignment.auditId,
              workFingerprint: assignment.workFingerprint,
              selectedEvidenceIds: assignment.selectedEvidenceIds,
              evidence: assignment.evidence.map(
                projectAuditorEvidenceRepresentation,
              ),
              evidenceProjection:
                projectAuditorEvidenceProjectionStatus(assignment),
              omissionSemantics:
                "Only whole explicitly selected canonical proof is admitted. adapterResult is unchanged. representedFields maps identical supplementary field values to exact paths under that same entry's adapterResult; all other supplements remain verbatim. No content is truncated or summarized. Pass requires complete inventory coverage and every needed ID in this current bundle. Previews and prior reviews are not proof.",
            }),
          },
        ]
      : [];
  return Object.freeze({
    context: projectRequestContext({
      instructions: buildAuditorDecisionInstructions(phase),
      format,
      historyMessages: [],
      prompt,
      referenceParts: [
        {
          sourceRef: `auditor:${assignment.auditId}:${phase}:${assignment.workFingerprint}`,
          category: "request_reference",
          retention: "exact",
          messages: [inventoryMessage, ...evidenceMessages],
        },
      ],
      budget,
      diagnostic: {
        requestId: request.requestId,
        modelStep: AUDITOR_DECISION_MODEL_STEP,
        callId: assignment.auditId,
      },
      onEvent: request.onEvent,
    }),
    format,
    modelStep: AUDITOR_DECISION_MODEL_STEP,
    assignment,
    phase,
  });
}
