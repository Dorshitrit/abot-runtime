import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import {
  createStructuredDecisionEnvelopeSchema,
  structuredDecisionVariantSchemaPath,
} from "../../model/structured-decision-envelope.js";
import {
  REVIEWER_DECISION_SUMMARY_MAX_LENGTH,
  REVIEWER_GAP_SUMMARY_MAX_LENGTH,
  REVIEWER_MAX_GAPS,
  REVIEWER_MAX_REFS_PER_GAP,
  type ReviewerReviewSnapshot,
} from "./contracts.js";

export function createReviewerDecisionFormat(
  snapshot: ReviewerReviewSnapshot,
): ModelGatewayJsonSchemaFormat {
  const passAllowed =
    snapshot.projectionComplete && snapshot.freshness !== "unavailable";
  const passVariant = exactObject(
    {
      action: literal("pass"),
      reviewScopeId: literal(snapshot.reviewScopeId),
      summary: boundedText(REVIEWER_DECISION_SUMMARY_MAX_LENGTH),
      gaps: {
        type: "array",
        minItems: 0,
        maxItems: 0,
        items: {
          type: "string",
          enum: ["__none__"],
        },
      },
    },
    ["action", "reviewScopeId", "summary", "gaps"],
  );
  const reportGapsVariant = exactObject(
    {
      action: literal("report_gaps"),
      reviewScopeId: literal(snapshot.reviewScopeId),
      summary: boundedText(REVIEWER_DECISION_SUMMARY_MAX_LENGTH),
      gaps: {
        type: "array",
        minItems: 1,
        maxItems: REVIEWER_MAX_GAPS,
        items: exactObject(
          {
            kind: enumString(snapshot.allowedGapKinds),
            subjectRefs: referenceArray(
              snapshot.subjects.map(({ subjectRef }) => subjectRef),
            ),
            factRefs: referenceArray(
              snapshot.facts.map(({ factRef }) => factRef),
            ),
            evidenceRefs: referenceArray(
              snapshot.evidence.map(({ evidenceRef }) => evidenceRef),
            ),
            summary: boundedText(REVIEWER_GAP_SUMMARY_MAX_LENGTH),
          },
          ["kind", "subjectRefs", "factRefs", "evidenceRefs", "summary"],
        ),
      },
    },
    ["action", "reviewScopeId", "summary", "gaps"],
  );
  const variants = passAllowed
    ? [passVariant, reportGapsVariant]
    : [reportGapsVariant];
  const reportGapsIndex = passAllowed ? 1 : 0;
  return {
    type: "json_schema",
    name: "reviewer_decision",
    strict: true,
    postValidatedSchemaConstraints: [
      ...(passAllowed
        ? [
            {
              keyword: "maxLength" as const,
              path: `${structuredDecisionVariantSchemaPath(0, variants.length)}/properties/summary/maxLength`,
            },
          ]
        : []),
      {
        keyword: "maxLength",
        path: `${structuredDecisionVariantSchemaPath(reportGapsIndex, variants.length)}/properties/summary/maxLength`,
      },
      {
        keyword: "maxLength",
        path: `${structuredDecisionVariantSchemaPath(reportGapsIndex, variants.length)}/properties/gaps/items/properties/summary/maxLength`,
      },
    ],
    schema: createStructuredDecisionEnvelopeSchema(variants),
  };
}

function referenceArray(values: readonly string[]): Record<string, unknown> {
  return {
    type: "array",
    minItems: 0,
    maxItems: Math.min(values.length, REVIEWER_MAX_REFS_PER_GAP),
    items: enumString(values),
  };
}

function exactObject(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function literal(value: string): Record<string, unknown> {
  return { type: "string", enum: [value] };
}

function enumString(values: readonly string[]): Record<string, unknown> {
  const uniqueValues = [...new Set(values)];
  return {
    type: "string",
    enum: uniqueValues.length > 0 ? uniqueValues : ["__none__"],
  };
}

function boundedText(maxLength: number): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    maxLength,
  };
}
