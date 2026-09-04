import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import {
  createStructuredDecisionEnvelopeSchema,
} from "../../model/structured-decision-envelope.js";
import { createReviewerAuditCoverageSchema } from "./audit-coverage.js";
import { projectReviewerVerificationCoverage } from "./verification-coverage.js";
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
  const verificationCoverage = projectReviewerVerificationCoverage(snapshot);
  const passAllowed =
    snapshot.projectionComplete &&
    snapshot.freshness !== "unavailable" &&
    verificationCoverage.complete;
  const passVariant = exactObject(
    {
      action: literal("pass"),
      reviewScopeId: literal(snapshot.reviewScopeId),
      audit: createReviewerAuditCoverageSchema(snapshot, {
        minimumCompletionEvidenceRefs: Math.min(2, snapshot.evidence.length),
      }),
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
    ["action", "reviewScopeId", "audit", "summary", "gaps"],
  );
  const reportGapsVariant = exactObject(
    {
      action: literal("report_gaps"),
      reviewScopeId: literal(snapshot.reviewScopeId),
      audit: createReviewerAuditCoverageSchema(snapshot, {
        minimumCompletionEvidenceRefs: 0,
      }),
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
    ["action", "reviewScopeId", "audit", "summary", "gaps"],
  );
  const variants = passAllowed
    ? [passVariant, reportGapsVariant]
    : [reportGapsVariant];
  const schema = createStructuredDecisionEnvelopeSchema(variants);
  return {
    type: "json_schema",
    name: "reviewer_decision",
    strict: true,
    postValidatedSchemaConstraints: collectMaxLengths(schema),
    schema,
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
