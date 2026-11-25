import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { collectDecisionMaxLengthConstraints, projectStrictControlsSchema } from "../../model/decision-schema.js";
import type { StructuredModelParseResult } from "../../model/invoke-structured-step.js";
import { readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import type { WorkerCapabilityDescriptor } from "../../orchestration/worker-capabilities/index.js";
import type { WorkerControlDecision, WorkerInvokeCapabilityDecision } from "./contracts.js";
import { parseWorkerFusedDecision, type WorkerFusedDecision } from "./fused-decision-format.js";
import type { buildWorkerDecisionInput } from "./input.js";
import { parseWorkerDecisionOutput } from "./parser.js";

type DecisionSchema = Record<string, unknown> & {
  anyOf?: readonly DecisionSchema[];
  properties?: Record<string, DecisionSchema>;
  required?: readonly string[];
};

/** Only the opted-in capability gains controls; all other choices stay available. */
export function createWorkerControlsFusionSelectionFormat(
  baseFormat: ModelGatewayJsonSchemaFormat,
  descriptor: WorkerCapabilityDescriptor,
): ModelGatewayJsonSchemaFormat {
  const schema = baseFormat.schema as DecisionSchema;
  const decision = schema.properties?.decision;
  if (!decision) throw new Error("worker_controls_fusion_selection_schema_missing");
  let invocationVariants = 0;
  const variants = (decision.anyOf ?? [decision]).flatMap((variant) => {
    const actions = variant.properties?.action?.enum;
    if (!Array.isArray(actions) || !actions.includes("invoke_capability")) return [variant];
    const capabilitySchema = variant.properties?.capabilityId;
    const capabilityIds = capabilitySchema?.enum;
    if (!Array.isArray(capabilityIds) || !capabilityIds.includes(descriptor.capabilityId)) return [variant];
    invocationVariants += 1;
    const fusedVariant = {
      ...variant,
      properties: {
        ...variant.properties,
        capabilityId: { ...capabilitySchema, enum: [descriptor.capabilityId] },
        controls: projectStrictControlsSchema(descriptor.controls),
      },
      required: [...(variant.required ?? []), "controls"],
    };
    const otherCapabilityIds = capabilityIds.filter((id) => id !== descriptor.capabilityId);
    if (otherCapabilityIds.length === 0) return [fusedVariant];
    return [fusedVariant, {
      ...variant,
      properties: {
        ...variant.properties,
        capabilityId: { ...capabilitySchema, enum: otherCapabilityIds },
      },
    }];
  });
  if (invocationVariants !== 1) throw new Error("worker_controls_fusion_selection_schema_invalid");
  let fusedDecision: DecisionSchema = { anyOf: variants };
  if (decision.anyOf) fusedDecision = { ...decision, anyOf: variants };
  else if (variants.length === 1) fusedDecision = variants[0]!;
  const fusedSchema = {
    ...schema,
    properties: {
      ...schema.properties,
      decision: fusedDecision,
    },
  };
  return {
    ...baseFormat,
    schema: fusedSchema,
    postValidatedSchemaConstraints: collectDecisionMaxLengthConstraints(fusedSchema),
  };
}

/** Validate selection first, then use the same frozen-selection controls parser. */
export function parseWorkerControlsFusedDecision(
  text: string,
  input: ReturnType<typeof buildWorkerDecisionInput>,
  evidenceRefs: readonly string[],
  descriptor: WorkerCapabilityDescriptor,
): StructuredModelParseResult<WorkerFusedDecision> {
  if (input.availableCapabilities.filter(({ capabilityId }) =>
    capabilityId === descriptor.capabilityId).length !== 1) {
    throw new Error("worker_controls_fusion_capability_scope_invalid");
  }
  let record: Record<string, unknown> | undefined;
  try { record = readStructuredDecisionEnvelope(JSON.parse(text)); } catch { /* Original parser rejects below. */ }
  const selection = record && readStructuredDecisionEnvelope({ decision: record.selection });
  if (!selection || selection.action !== "invoke_capability" ||
    selection.capabilityId !== descriptor.capabilityId) {
    return parseWorkerFusedDecision(text, input, evidenceRefs);
  }
  const { controls, ...selectionWithoutControls } = selection;
  const parsed = parseWorkerFusedDecision(JSON.stringify({
    decision: { ...record, selection: selectionWithoutControls },
  }), input, evidenceRefs);
  if (!parsed.ok || parsed.decision.selection.action !== "invoke_capability") return parsed;
  const acceptedSelection = parsed.decision.selection;
  const execution = parseWorkerDecisionOutput(JSON.stringify({
    decision: { action: "invoke_capability", controls },
  }), input.diagnostic, {
    availableCapabilities: input.availableCapabilities,
    maxBatchCapabilityExecutions: input.maxBatchCapabilityExecutions,
    decisionPhase: "capability_execution",
    allowedActions: input.allowedActions,
    pendingCapabilitySelection: acceptedSelection,
  });
  if (!execution.ok) return execution;
  return {
    ok: true,
    decision: Object.freeze({
      assessment: parsed.decision.assessment,
      selection: execution.decision,
    }),
  };
}

/** Only accepted decisions reach the execution/refinement boundary. */
export function isMaterializedWorkerCapabilityDecision(
  decision: WorkerControlDecision,
): decision is WorkerInvokeCapabilityDecision {
  return decision.action === "invoke_capability" && "controls" in decision;
}
