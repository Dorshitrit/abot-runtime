import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";

function stageFormat(name: string, properties: Record<string, unknown>, boundedFields: readonly string[] = []): ModelGatewayJsonSchemaFormat {
  return { type: "json_schema", name, strict: true,
    postValidatedSchemaConstraints: boundedFields.map(field => ({ keyword: "maxLength" as const,
      path: `/properties/${field}/maxLength` })),
    schema: { type: "object", additionalProperties: false, required: Object.keys(properties), properties } };
}

export const STAGED_PROACTIVE_SELECTION_FORMAT = stageFormat("co_worker_proactive_sources_v2", {
  sourceRefs: { type: "array", maxItems: 12, items: { type: "string" } },
});

export const STAGED_PROACTIVE_OBJECTIVE_FORMAT = stageFormat("co_worker_proactive_objective_v2", {
  objective: { type: ["string", "null"], maxLength: 1000 },
}, ["objective"]);

/** Explicit plain text overrides the learning.batch JSON calibration at the provider boundary. */
export const STAGED_PROACTIVE_AUTHORING_FORMAT = Object.freeze({ type: "text" as const, calibrationInstructions: "omit" as const });

export function createStagedProactiveTimingFormat(hasProposal: boolean): ModelGatewayJsonSchemaFormat {
  return stageFormat("co_worker_proactive_timing_v2", {
    ...(hasProposal ? { expiresInMinutes: { type: "integer", minimum: 1, maximum: 43_200 } } : {}),
    reconsiderInMinutes: { type: ["integer", "null"], minimum: 1, maximum: 43_200 },
  });
}
