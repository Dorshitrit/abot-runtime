import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { collectDecisionMaxLengthConstraints } from "../../model/decision-schema.js";
import type { StructuredModelParseResult } from "../../model/invoke-structured-step.js";
import { createStructuredDecisionEnvelopeSchema, readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import type { WorkerControlDecision } from "./contracts.js";
import { createAssessmentFormat, parseWorkerEvidenceAssessmentOutput, type WorkerEvidenceAssessmentDecision } from "./evidence-assessment.js";
import type { buildWorkerDecisionInput } from "./input.js";
import { parseWorkerDecisionOutput } from "./parser.js";

export type WorkerFusedDecision = Readonly<{
  assessment: WorkerEvidenceAssessmentDecision;
  selection: WorkerControlDecision;
}>;

type DecisionSchema = Record<string, unknown> & {
  anyOf?: readonly DecisionSchema[];
  properties?: Record<string, Record<string, unknown>>;
};

export function createWorkerFusedDecisionFormat(
  selectionFormat: ModelGatewayJsonSchemaFormat,
  evidenceRefs: readonly string[],
): ModelGatewayJsonSchemaFormat {
  const assessment = decisionSchema(createAssessmentFormat(evidenceRefs));
  const selection = decisionSchema(selectionFormat);
  const selections = selection.anyOf ?? [selection];
  const ready = selections.filter(isResultSelectionSchema);
  const execution = selections.filter((variant) => !isResultSelectionSchema(variant));
  const schema = createStructuredDecisionEnvelopeSchema([
    ...(ready.length ? [createFusedVariant(assessment, ready, false)] : []),
    ...(execution.length ? [createFusedVariant(assessment, execution, true)] : []),
  ]);
  return {
    type: "json_schema", name: "worker_evidence_and_selection", strict: true,
    schema, postValidatedSchemaConstraints: collectDecisionMaxLengthConstraints(schema),
  };
}

function createFusedVariant(
  assessment: DecisionSchema,
  selections: readonly DecisionSchema[],
  requiresExecution: boolean,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      assessment: {
        ...assessment,
        properties: {
          ...assessment.properties,
          requiresExecution: { type: "boolean", enum: [requiresExecution] },
          remaining: {
            ...assessment.properties?.remaining,
            ...(requiresExecution ? { minLength: 1 } : { enum: [""] }),
          },
        },
      },
      selection: selections.length === 1 ? selections[0]! : { anyOf: selections },
    },
    required: ["assessment", "selection"],
    additionalProperties: false,
  };
}

function isResultSelectionSchema(schema: DecisionSchema): boolean {
  const actions = schema.properties?.action?.enum;
  return Array.isArray(actions) && actions.length === 1 && actions[0] === "return_result";
}

export function parseWorkerFusedDecision(
  text: string,
  input: ReturnType<typeof buildWorkerDecisionInput>,
  evidenceRefs: readonly string[],
): StructuredModelParseResult<WorkerFusedDecision> {
  let record: Record<string, unknown> | undefined;
  try { record = readStructuredDecisionEnvelope(JSON.parse(text)); } catch { /* Rejected below. */ }
  if (!record || Object.keys(record).length !== 2 || !("assessment" in record) || !("selection" in record))
    return rejectWorkerFusedDecision("Return exactly decision.assessment and decision.selection.");
  const assessment = parseWorkerEvidenceAssessmentOutput(JSON.stringify({ decision: record.assessment }), evidenceRefs);
  if (!assessment.ok) return assessment;
  const selection = parseWorkerDecisionOutput(JSON.stringify({ decision: record.selection }), input.diagnostic, {
    availableCapabilities: input.availableCapabilities,
    maxBatchCapabilityExecutions: input.maxBatchCapabilityExecutions,
    decisionPhase: "capability_selection",
    allowedActions: input.allowedActions,
  });
  if (!selection.ok) return selection;
  if (!hasConsistentWorkerEvidenceSelection(assessment.decision, selection.decision))
    return rejectWorkerFusedDecision("Use return_result exactly when no external execution remains; its assessment requiresExecution is false and remaining is empty. Other actions requireExecution=true.");
  return { ok: true, decision: Object.freeze({ assessment: assessment.decision, selection: selection.decision }) };
}

function hasConsistentWorkerEvidenceSelection(
  assessment: WorkerEvidenceAssessmentDecision,
  selection: WorkerControlDecision,
): boolean {
  return assessment.requiresExecution === (selection.action !== "return_result");
}

function decisionSchema(format: ModelGatewayJsonSchemaFormat): DecisionSchema {
  const schema = format.schema as { properties?: { decision?: DecisionSchema } };
  if (!schema.properties?.decision) throw new Error("worker_fused_decision_schema_missing");
  return schema.properties.decision;
}

function rejectWorkerFusedDecision(message: string): StructuredModelParseResult<WorkerFusedDecision> {
  return { ok: false, stage: "worker_fused_decision", issues: [{
    code: "worker_fused_decision_inconsistent", path: "decision", message,
  }] };
}
