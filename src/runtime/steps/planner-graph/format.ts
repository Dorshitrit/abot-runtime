import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { createStructuredDecisionEnvelopeSchema } from "../../model/structured-decision-envelope.js";
import {
  PLANNER_GRAPH_IDENTIFIER_MAX_LENGTH,
  PLANNER_GRAPH_TEXT_MAX_LENGTH,
  sealPlannerGraphLimits,
  type PlannerGraphLimits,
} from "./contracts.js";

export function createPlannerGraphFormat(
  inputLimits: PlannerGraphLimits,
): ModelGatewayJsonSchemaFormat {
  const limits = sealPlannerGraphLimits(inputLimits);
  const text = boundedText(PLANNER_GRAPH_TEXT_MAX_LENGTH);
  const identifier = boundedText(PLANNER_GRAPH_IDENTIFIER_MAX_LENGTH);
  const criterion = exactObject({
    localId: identifier,
    description: text,
    verification: { type: "string", enum: ["mechanical", "semantic"] },
  });
  const node = exactObject({
    localId: identifier,
    title: text,
    objective: text,
    dependsOn: {
      type: "array",
      maxItems: limits.maxPlanNodes,
      items: identifier,
    },
    acceptanceCriteria: {
      type: "array",
      minItems: 1,
      maxItems: limits.maxCriteriaPerNode,
      items: criterion,
    },
  });
  const schema = createStructuredDecisionEnvelopeSchema([
    exactObject({
      summary: text,
      nodes: {
        type: "array",
        minItems: 2,
        maxItems: limits.maxPlanNodes,
        items: node,
      },
    }),
    exactObject({
      action: { type: "string", enum: ["decline"] },
      reason: text,
    }),
  ]);
  return Object.freeze({
    type: "json_schema" as const,
    name: "planner_graph_proposal",
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
