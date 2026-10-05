import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import {
  SEMANTIC_COMPACTION_LIST_MAX_COUNT,
  SEMANTIC_COMPACTION_TEXT_MAX_LENGTH,
  type SemanticCompactionSourceIdentity,
} from "./contracts.js";
import { bindSemanticCompactionSourceSlots } from "./source-slots.js";

// OpenAI Structured Outputs permits 5000 object properties in one schema.
// Reserve the two root properties and ten continuation properties.
export const SEMANTIC_COMPACTION_BATCH_SOURCE_MAX_COUNT = 5_000 - 12;

export function createSemanticCompactionFormat(
  expectedSources: readonly SemanticCompactionSourceIdentity[],
  checkpointTokenAllowance: number,
): ModelGatewayJsonSchemaFormat {
  if (expectedSources.length > SEMANTIC_COMPACTION_BATCH_SOURCE_MAX_COUNT) {
    throw new Error("context_compaction_source_count_exceeds_schema_limit");
  }
  const sourceRefs = expectedSources.map(({ sourceRef }) => sourceRef);
  const hasUniqueSourceRefs =
    sourceRefs.length > 0 && new Set(sourceRefs).size === sourceRefs.length;
  if (!hasUniqueSourceRefs) {
    throw new Error("context_compaction_source_refs_invalid");
  }
  const hasPositiveCheckpointTokenAllowance =
    Number.isSafeInteger(checkpointTokenAllowance) && checkpointTokenAllowance > 0;
  if (!hasPositiveCheckpointTokenAllowance)
    throw new Error("context_compaction_token_allowance_invalid");
  const textListSchema = Object.freeze({
    type: "array",
    maxItems: SEMANTIC_COMPACTION_LIST_MAX_COUNT,
    items: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: SEMANTIC_COMPACTION_TEXT_MAX_LENGTH,
    }),
  });
  const sourceKeys = bindSemanticCompactionSourceSlots(expectedSources).map(
    ({ sourceKey }) => sourceKey,
  );
  return Object.freeze({
    type: "json_schema" as const,
    name: "context_compaction",
    strict: true,
    postValidatedSchemaConstraints: Object.freeze([
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
      description: `The complete checkpoint (sourceDigests, continuation, and runtime source-reference envelope) must fit ${checkpointTokenAllowance} input tokens for its consuming model. This is one shared allowance for the complete checkpoint.`,
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
          type: "object",
          description: "Allocate the shared checkpoint token budget according to the evidence needed from each source. Sources have no equal quotas or separate character limits. Preserve complete facts within the shared allowance.",
          properties: Object.freeze(
            Object.fromEntries(
              sourceKeys.map((key) => [
                key,
                Object.freeze({
                  type: "string",
                  minLength: 1,
                }),
              ]),
            ),
          ),
          required: Object.freeze(sourceKeys),
          additionalProperties: false,
        }),
      }),
      required: Object.freeze(["continuation", "sourceDigests"]),
      additionalProperties: false,
    }),
  });
}
