import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { createStructuredDecisionEnvelopeSchema } from "../../model/structured-decision-envelope.js";
import {
  AUDITOR_DECISION_TEXT_MAX_LENGTH,
  projectAuditorEvidenceProjectionStatus,
  type AuditorAssignment,
} from "./contracts.js";

export function createAuditorDecisionFormat(
  assignment: AuditorAssignment,
): ModelGatewayJsonSchemaFormat {
  const criterionIds = [...assignment.criterionIds];
  const criterionCoverage = {
    type: "array",
    minItems: criterionIds.length,
    maxItems: criterionIds.length,
    items: { type: "string", enum: criterionIds },
  };
  const common = {
    auditId: literal(assignment.auditId),
    criterionIds: criterionCoverage,
  };
  const passAllowed =
    projectAuditorEvidenceProjectionStatus(assignment).complete;
  const variants = [
    ...(passAllowed
      ? [
          exactObject({
            ...common,
            verdict: literal("pass"),
            gaps: {
              type: "array",
              minItems: 0,
              maxItems: 0,
              items: { type: "string", enum: ["__none__"] },
            },
          }),
        ]
      : []),
    exactObject({
      ...common,
      verdict: literal("gaps"),
      gaps: {
        type: "array",
        minItems: 1,
        maxItems: criterionIds.length,
        items: exactObject({
          criterionId: { type: "string", enum: criterionIds },
          description: boundedText(AUDITOR_DECISION_TEXT_MAX_LENGTH),
        }),
      },
    }),
  ];
  const schema = createStructuredDecisionEnvelopeSchema(variants);
  return Object.freeze({
    type: "json_schema" as const,
    name: "auditor_decision",
    strict: true,
    postValidatedSchemaConstraints: collectMaxLengths(schema),
    schema,
  });
}

function exactObject(
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function literal(value: string): Record<string, unknown> {
  return { type: "string", enum: [value] };
}

function boundedText(maxLength: number): Record<string, unknown> {
  return { type: "string", minLength: 1, maxLength };
}

function collectMaxLengths(
  value: unknown,
  path = "",
): Array<Readonly<{ keyword: "maxLength"; path: string }>> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectMaxLengths(entry, `${path}/${index}`),
    );
  }
  if (!isRecord(value)) return [];
  return [
    ...(Object.hasOwn(value, "maxLength")
      ? [{ keyword: "maxLength" as const, path: `${path}/maxLength` }]
      : []),
    ...Object.entries(value).flatMap(([key, child]) =>
      collectMaxLengths(child, `${path}/${escapePointer(key)}`),
    ),
  ];
}

function escapePointer(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
