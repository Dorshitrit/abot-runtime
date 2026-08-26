import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import { projectRequestContext } from "../../context/request-context.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import {
  AUDITOR_DECISION_MODEL_STEP,
  projectAuditorEvidenceProjectionStatus,
  type AuditorAssignment,
} from "./contracts.js";
import { createAuditorDecisionFormat } from "./format.js";
import { buildAuditorDecisionInstructions } from "./prompt.js";
import { projectAuditorAssignment } from "./projection.js";

export function buildAuditorDecisionInput(
  request: RequestExecutionSeed,
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): Readonly<{
  context: RequestContextProjection;
  format: ModelGatewayJsonSchemaFormat;
  modelStep: typeof AUDITOR_DECISION_MODEL_STEP;
  assignment: AuditorAssignment;
}> {
  const assignment = projectAuditorAssignment(request, head, call);
  const evidenceProjection = projectAuditorEvidenceProjectionStatus(assignment);
  const format = createAuditorDecisionFormat(assignment);
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
    authority: "role_call_objective",
    presenceEffect: "audit_assignment_only_not_execution_or_completion",
    auditId: assignment.auditId,
    callerCallId: assignment.callerCallId,
    sourceRevision: assignment.sourceRevision,
    target: assignment.target,
    criteria: assignment.criteria,
  });
  const evidenceMessage = Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: "runtime_execution_agent_auditor_evidence_v1",
      authority: "runtime_evidence",
      presenceEffect: "passive_evidence_not_user_intent_or_completion",
      auditId: assignment.auditId,
      sourceRevision: assignment.sourceRevision,
      evidence: assignment.evidence,
      evidenceProjection,
      omissionSemantics: {
        entryAdmission:
          "Only whole canonical entries are admitted within the declared count and character bounds; entry content is never summarized or truncated.",
        passEligibility:
          "pass is available only when evidenceProjection.complete is true. Any omitted entry or empty evidence set makes gaps the only valid verdict.",
        evidenceClaim:
          "Each entry establishes only its exact runtime-recorded bounded outcome; the Auditor decides semantic sufficiency.",
      },
    }),
  });
  return Object.freeze({
    context: projectRequestContext({
      instructions: buildAuditorDecisionInstructions(),
      format,
      historyMessages: [],
      prompt,
      referenceMessages: [evidenceMessage],
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
  });
}
