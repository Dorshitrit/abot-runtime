import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import {
  createStructuredDecisionEnvelopeSchema,
  readStructuredDecisionEnvelope,
} from "../../model/structured-decision-envelope.js";
import type { StructuredModelParseResult } from "../../model/invoke-structured-step.js";
import type { AuditorAssignment } from "./contracts.js";
import { auditEvidenceSelectionIssue } from "./evidence-binding.js";

export type AuditorEvidenceSelection = Readonly<{
  auditId: string;
  selectedEvidenceIds: readonly string[];
}>;

export function createAuditorEvidenceSelectionFormat(
  assignment: AuditorAssignment,
): ModelGatewayJsonSchemaFormat {
  return Object.freeze({
    type: "json_schema" as const,
    name: "auditor_evidence_selection",
    strict: true,
    schema: createStructuredDecisionEnvelopeSchema([
      {
        type: "object",
        additionalProperties: false,
        required: ["auditId", "selectedEvidenceIds"],
        properties: {
          auditId: { type: "string", enum: [assignment.auditId] },
          selectedEvidenceIds: {
            type: "array",
            minItems: 1,
            maxItems: assignment.inventory.length,
            items: {
              type: "string",
              enum: assignment.inventory.map(({ executionId }) => executionId),
            },
          },
        },
      },
    ]),
  });
}

export function parseAuditorEvidenceSelection(
  text: string,
  assignment: AuditorAssignment,
): StructuredModelParseResult<AuditorEvidenceSelection> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    return reject("auditor_selection_not_json");
  }
  const decision = readStructuredDecisionEnvelope(decoded);
  if (!decision) return reject("auditor_selection_envelope_invalid");
  if (!hasExactSelectionFields(decision))
    return reject("auditor_selection_shape_invalid");
  if (decision.auditId !== assignment.auditId)
    return reject("auditor_selection_id_mismatch");
  const issue = auditEvidenceSelectionIssue(
    decision.selectedEvidenceIds,
    assignment,
  );
  if (issue) return reject(issue);
  return Object.freeze({
    ok: true as const,
    decision: Object.freeze({
      auditId: assignment.auditId,
      selectedEvidenceIds: Object.freeze([
        ...(decision.selectedEvidenceIds as string[]),
      ]),
    }),
  });
}

function hasExactSelectionFields(value: Record<string, unknown>): boolean {
  if (Object.keys(value).length !== 2) return false;
  return (
    Object.hasOwn(value, "auditId") &&
    Object.hasOwn(value, "selectedEvidenceIds")
  );
}

function reject(
  code: string,
): StructuredModelParseResult<AuditorEvidenceSelection> {
  return Object.freeze({
    ok: false as const,
    stage: "domain_parser",
    issues: Object.freeze([
      { code, path: "decision.selectedEvidenceIds", message: code },
    ]),
  });
}
