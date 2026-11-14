import type {
  ModelGatewayJsonSchemaFormat,
  ModelStructuredOutputRepair,
} from "../../model-gateway/types.js";
import { validateJsonSchemaValue } from "./json-schema-value.js";

/**
 * Classifies an already rejected, complete output. This is not acceptance:
 * unknown schema constraints and domain decisions stay with the owning parser.
 */
export function resolveStructuredOutputRepair(
  text: string,
  format: ModelGatewayJsonSchemaFormat,
): ModelStructuredOutputRepair | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return "json_schema_violation";
  }
  if (validateJsonSchemaValue(format.schema, decoded)) {
    return "json_schema_violation";
  }
  return undefined;
}
