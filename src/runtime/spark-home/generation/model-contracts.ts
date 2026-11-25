import { projectStrictControlsSchema } from "../../model/decision-schema.js";
import { validateToolNormalInvocationInput } from "../../../capabilities/normal-invocation/validator.js";
import type { ToolNormalInvocationInput } from "../../../capabilities/tool-types.js";
import { homeGenerationFailure, type SparkHomePlan, type SparkHomeReadDescriptor, type SparkHomeReadSelection } from "./contracts.js";

export const SPARK_HOME_READS_PER_PHASE = 4;
function homeReadControlsFormat(input: ToolNormalInvocationInput): Record<string, unknown> {
  const strict = projectStrictControlsSchema(input);
  // Retain the serialized field order of existing flat Home tool schemas.
  return input.anyOf ? strict : { ...input, ...strict };
}
function captureHomeReadControls(value: unknown, input: ToolNormalInvocationInput): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => {
    if (!Object.hasOwn(input.properties, key)) return true;
    if (input.required.includes(key)) return true;
    return item !== null;
  }));
}
export function homePlanFormat(operations: readonly SparkHomeReadDescriptor[]) {
  const variants = operations.map(operation => ({ type: "object", additionalProperties: false,
    required: ["operation", "purpose", "controls"], properties: {
      operation: { type: "string", enum: [operation.id] }, purpose: { type: "string", minLength: 1, maxLength: 400 },
      controls: homeReadControlsFormat(operation.input as ToolNormalInvocationInput),
    } }));
  return { type: "json_schema", name: "spark_home_plan", strict: true, schema: {
    type: "object", additionalProperties: false, required: ["direction", "reads"], properties: {
      direction: { type: "string", minLength: 1, maxLength: 1800 },
      reads: { type: "array", maxItems: operations.length ? SPARK_HOME_READS_PER_PHASE : 0,
        items: variants.length ? { anyOf: variants } : { type: "object", additionalProperties: false, properties: {}, required: [] } },
    },
  } };
}
function parseHomeRead(value: unknown, operations: readonly SparkHomeReadDescriptor[]): SparkHomeReadSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return homeGenerationFailure("spark_home_plan_invalid");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !["operation", "purpose", "controls"].includes(key))) return homeGenerationFailure("spark_home_plan_invalid");
  const operation = operations.find(option => option.id === item.operation);
  if (!operation) return homeGenerationFailure("spark_home_read_unavailable");
  if (typeof item.purpose !== "string" || !item.purpose.trim() || item.purpose.length > 400) return homeGenerationFailure("spark_home_plan_invalid");
  const schema = operation.input as ToolNormalInvocationInput;
  const controls = validateToolNormalInvocationInput({ operationId: operation.id, summary: operation.summary,
    input: schema, effect: "read_only", approval: "request_policy" }, captureHomeReadControls(item.controls, schema));
  if (!controls.ok) return homeGenerationFailure("spark_home_read_controls_invalid");
  return { operation: operation.id, purpose: item.purpose, controls: controls.value };
}
export function parseHomePlan(text: string, operations: readonly SparkHomeReadDescriptor[]): SparkHomePlan {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return homeGenerationFailure("spark_home_plan_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return homeGenerationFailure("spark_home_plan_invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["direction", "reads"].includes(key))) return homeGenerationFailure("spark_home_plan_invalid");
  if (typeof input.direction !== "string" || !input.direction.trim() || input.direction.length > 1800) return homeGenerationFailure("spark_home_plan_invalid");
  if (!Array.isArray(input.reads) || input.reads.length > SPARK_HOME_READS_PER_PHASE) return homeGenerationFailure("spark_home_plan_invalid");
  return { direction: input.direction, reads: input.reads.map(read => parseHomeRead(read, operations)) };
}
