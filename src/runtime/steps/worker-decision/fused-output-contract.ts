import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { createAssessmentFormat } from "./evidence-assessment.js";

type Schema = Record<string, unknown>;

export const WORKER_OUTPUT_TYPE_NOTATION =
  "JSON type shape, not literal values: exact keys, '?' means optional, no extra keys. [min..max] bounds string length or array size; '*' is unbounded.";

/** The selected Controls phase uses the same notation without fused readiness rules. */
export function projectWorkerControlsOutputType(format: ModelGatewayJsonSchemaFormat): string {
  return renderType(format.schema as Schema);
}

/** Compact type notation for the same output fields; provider validation stays canonical. */
export function projectWorkerFusedOutputContract(
  selectionFormat: ModelGatewayJsonSchemaFormat,
  evidenceRefs: readonly string[],
): string {
  const assessment = decisionSchema(createAssessmentFormat(evidenceRefs));
  const selection = decisionSchema(selectionFormat);
  return [
    `${WORKER_OUTPUT_TYPE_NOTATION} Apply the readiness rules above.`,
    `{decision:{assessment:${renderType(assessment)},selection:${renderType(selection)}}}`,
  ].join("\n");
}

function decisionSchema(format: ModelGatewayJsonSchemaFormat): Schema {
  return (format.schema as { properties: { decision: Schema } }).properties.decision;
}

function renderType(schema: Schema): string {
  const represented = new Set(["description", "type"]);
  let type: string;
  if (Array.isArray(schema.anyOf)) {
    represented.add("anyOf");
    type = `(${schema.anyOf.map((variant) => renderType(variant as Schema)).join("|")})`;
  } else if (Array.isArray(schema.enum)) {
    represented.add("enum");
    type = schema.enum.map((value) => JSON.stringify(value)).join("|");
    if (schema.enum.length > 1) type = `(${type})`;
  } else if (schema.type === "object") {
    represented.add("properties");
    represented.add("required");
    represented.add("additionalProperties");
    const required = Array.isArray(schema.required) ? schema.required : [];
    const fields = Object.entries((schema.properties ?? {}) as Record<string, Schema>)
      .map(([key, value]) => `${fieldName(key)}${required.includes(key) ? "" : "?"}:${renderType(value)}`);
    if (schema.additionalProperties !== false) {
      fields.push(`[otherKey:string]:${isSchema(schema.additionalProperties) ? renderType(schema.additionalProperties) : "unknown"}`);
    }
    type = `{${fields.join(",")}}`;
  } else if (schema.type === "array") {
    represented.add("items");
    if (schema.maxItems === 0) {
      represented.add("maxItems");
      represented.add("uniqueItems");
      type = "[]";
    } else {
      type = `Array<${isSchema(schema.items) ? renderType(schema.items) : "unknown"}>${lengthBounds(schema, represented, "minItems", "maxItems")}`;
      if (schema.uniqueItems === true) {
        represented.add("uniqueItems");
        type += " unique";
      }
    }
  } else if (schema.type === "string") {
    type = `string${lengthBounds(schema, represented, "minLength", "maxLength")}`;
  } else {
    type = typeof schema.type === "string" ? schema.type : JSON.stringify(schema.type ?? "unknown");
  }
  const constraints = Object.fromEntries(Object.entries(schema).filter(([key]) => !represented.has(key)));
  return Object.keys(constraints).length ? `${type}${JSON.stringify(constraints)}` : type;
}

function lengthBounds(schema: Schema, represented: Set<string>, minimum: string, maximum: string): string {
  if (schema[minimum] === undefined && schema[maximum] === undefined) return "";
  represented.add(minimum);
  represented.add(maximum);
  return `[${schema[minimum] ?? 0}..${schema[maximum] ?? "*"}]`;
}

function fieldName(key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? key : JSON.stringify(key);
}

function isSchema(value: unknown): value is Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
