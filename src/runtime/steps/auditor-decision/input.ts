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
  selectedEvidenceChars: number;
  reusedCompactedSourceCount: number;
}> {
  const compactedById = new Map(
    assignment.compactedSourceEvidence?.sources.map((source) => [
      source.executionId,
      source,
    ]),
  );
  const evidence =
    phase === "review"
      ? assignment.evidence.map((entry) =>
          projectAuditorEvidenceRepresentation(
            entry,
            compactedById.get(entry.executionId),
          ),
        )
      : [];
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
          "exactEvidenceChars measures the original representation. For evidencePresentation=compacted, projectedEvidenceChars measures the verified source summary and retained receipt that will be supplied instead. Canonical fingerprints bind the unchanged original records. Runtime admits the complete review message under the configured context policy without further compaction.",
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
              evidence,
              evidenceProjection:
                projectAuditorEvidenceProjectionStatus(assignment),
              omissionSemantics:
                "Each selected entry contains its unchanged adapterResult or a verified existing compactedSourceEvidence summary of that same execution. Summaries may omit detail; omission does not establish absence. evidenceProjection.complete means all selected representations are present, not that summaries retain every original fact. representedFields maps identical supplements to exact paths in that entry's adapterResult; other supplements remain verbatim. Pass requires complete inventory classification and every needed ID in this current bundle with facts sufficient for the criteria. Previews and prior reviews are not proof.",
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
      deferCompactionFailure: true,
    }),
    format,
    modelStep: AUDITOR_DECISION_MODEL_STEP,
    assignment,
    phase,
    selectedEvidenceChars: evidence.reduce(
      (total, entry) => total + JSON.stringify(entry).length,
      0,
    ),
    reusedCompactedSourceCount: evidence.filter(
      (entry) => entry.compactedSourceEvidence,
    ).length,
  });
}
