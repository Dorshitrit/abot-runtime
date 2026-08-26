import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import {
  SEMANTIC_COMPACTION_DIGEST_MAX_LENGTH,
  SEMANTIC_COMPACTION_LIST_MAX_COUNT,
  SEMANTIC_COMPACTION_TEXT_MAX_LENGTH,
  type SemanticCompactionSourceIdentity,
} from "./contracts.js";

export function createSemanticCompactionFormat(
  expectedSources: readonly SemanticCompactionSourceIdentity[],
  digestMaxLength = SEMANTIC_COMPACTION_DIGEST_MAX_LENGTH,
): ModelGatewayJsonSchemaFormat {
  const sourceRefs = expectedSources.map(({ sourceRef }) => sourceRef);
  if (
    sourceRefs.length === 0 ||
    new Set(sourceRefs).size !== sourceRefs.length ||
    !Number.isSafeInteger(digestMaxLength) ||
    digestMaxLength < 1 ||
    digestMaxLength > SEMANTIC_COMPACTION_DIGEST_MAX_LENGTH
  ) {
    throw new Error("context_compaction_source_refs_invalid");
  }
  const textListSchema = Object.freeze({
    type: "array",
    maxItems: SEMANTIC_COMPACTION_LIST_MAX_COUNT,
    items: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: SEMANTIC_COMPACTION_TEXT_MAX_LENGTH,
    }),
  });
  return Object.freeze({
    type: "json_schema" as const,
    name: "context_compaction",
    strict: true,
    postValidatedSchemaConstraints: Object.freeze([
      Object.freeze({
        keyword: "maxLength" as const,
        path: "/properties/sourceDigests/items/maxLength",
      }),
      ...[
        "completed",
        "findings",
        "evidenceRefs",
        "artifacts",
        "decisions",
        "failedApproaches",
        "openWork",
        "blockers",
      ].map((field) =>
        Object.freeze({
          keyword: "maxLength" as const,
          path: `/properties/continuation/properties/${field}/items/maxLength`,
        }),
      ),
      Object.freeze({
        keyword: "maxLength" as const,
        path: "/properties/continuation/properties/currentState/maxLength",
      }),
      Object.freeze({
        keyword: "maxLength" as const,
        path: "/properties/continuation/properties/nextStep/maxLength",
      }),
    ]),
    schema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        continuation: Object.freeze({
          type: "object",
          properties: Object.freeze({
            completed: textListSchema,
            currentState: Object.freeze({
              type: "string",
              minLength: 1,
              maxLength: SEMANTIC_COMPACTION_TEXT_MAX_LENGTH,
            }),
            findings: textListSchema,
            evidenceRefs: textListSchema,
            artifacts: textListSchema,
            decisions: textListSchema,
            failedApproaches: textListSchema,
            openWork: textListSchema,
            blockers: textListSchema,
            nextStep: Object.freeze({
              type: "string",
              minLength: 1,
              maxLength: SEMANTIC_COMPACTION_TEXT_MAX_LENGTH,
            }),
          }),
          required: Object.freeze([
            "completed",
            "currentState",
            "findings",
            "evidenceRefs",
            "artifacts",
            "decisions",
            "failedApproaches",
            "openWork",
            "blockers",
            "nextStep",
          ]),
          additionalProperties: false,
        }),
        sourceDigests: Object.freeze({
          type: "array",
          minItems: sourceRefs.length,
          maxItems: sourceRefs.length,
          items: Object.freeze({
            type: "string",
            minLength: 1,
            maxLength: digestMaxLength,
          }),
        }),
      }),
      required: Object.freeze(["continuation", "sourceDigests"]),
      additionalProperties: false,
    }),
  });
}
