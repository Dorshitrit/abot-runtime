import {
  isModelGatewayJsonSchemaFormat, isPlainObject, rejectMisplacedProjectionMetadata,
} from "../../structured-output/format-contract.js";
import type { ModelGatewayFormat } from "../../types.js";

// llama.cpp consumes the schema as grammar; do not inject it into model messages
// or drop constraints just because another provider cannot represent them.
export function projectLlamaCppFormat(format?: ModelGatewayFormat): Record<string, unknown> | undefined {
  if (format === undefined) return undefined;
  if (format === "json") return { type: "json_object" };
  if (isModelGatewayJsonSchemaFormat(format)) {
    return {
      type: "json_schema",
      json_schema: {
        name: format.name, schema: format.schema,
        ...(format.description !== undefined ? { description: format.description } : {}),
        ...(format.strict !== undefined ? { strict: format.strict } : {}),
      },
    };
  }
  if (!isPlainObject(format)) throw new TypeError("llamacpp_format_invalid");
  rejectMisplacedProjectionMetadata(format);
  if (format.type === "text") return undefined;
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema") throw new TypeError("llamacpp_json_schema_wrapper_invalid");
  return { type: "json_schema", json_schema: { name: "runtime_output", schema: format } };
}
