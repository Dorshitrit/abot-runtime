import type {
  ModelGatewayFormat,
  ModelGatewayJsonSchemaFormat,
} from "../types.js";
import {
  isModelGatewayJsonSchemaFormat,
  isPlainObject,
  rejectMisplacedProjectionMetadata,
} from "./format-contract.js";

const OPENAI_GENERIC_SCHEMA_NAME = "runtime_structured_output";

export type OpenAISchemaProjectionDiagnostic = Readonly<{
  action: "schema_instruction_injected";
  schemaName: string;
  reason: "openai_root_union_unsupported";
  instructionCharacterCount: number;
}>;

export type OpenAIFormatProjection = Readonly<{
  format: Record<string, unknown> | undefined;
  instructions: readonly string[];
  diagnostics: readonly OpenAISchemaProjectionDiagnostic[];
}>;

function hasUnsupportedRootUnion(schema: Record<string, unknown>): boolean {
  return (
    Array.isArray(schema.oneOf) ||
    Array.isArray(schema.anyOf) ||
    Array.isArray(schema.allOf)
  );
}

function emptyProjection(
  format: Record<string, unknown> | undefined,
): OpenAIFormatProjection {
  return {
    format,
    instructions: Object.freeze([]),
    diagnostics: Object.freeze([]),
  };
}

function standardJsonSchemaFormat(
  format: ModelGatewayJsonSchemaFormat,
): Record<string, unknown> {
  return {
    type: "json_schema",
    name: format.name,
    schema: format.schema,
    ...(format.description === undefined
      ? {}
      : { description: format.description }),
    ...(format.strict === undefined ? {} : { strict: format.strict }),
  };
}

function rootUnionFallback(
  schemaName: string,
  schema: Record<string, unknown>,
): OpenAIFormatProjection {
  const instruction = [
    `The required response contract is the JSON Schema named ${JSON.stringify(schemaName)} below.`,
    "The provider is using JSON mode because the schema has a root union.",
    "Return exactly one JSON object matching exactly one schema variant.",
    "Use only fields declared by that selected variant. Do not rename fields or add wrapper, discriminator, response, or schema metadata fields unless the selected variant explicitly declares them.",
    `JSON Schema: ${JSON.stringify(schema)}`,
  ].join("\n");
  return {
    format: { type: "json_object" },
    instructions: Object.freeze([instruction]),
    diagnostics: Object.freeze([
      {
        action: "schema_instruction_injected",
        schemaName,
        reason: "openai_root_union_unsupported",
        instructionCharacterCount: instruction.length,
      },
    ]),
  };
}

export function projectOpenAIResponsesFormat(
  format: ModelGatewayFormat | undefined,
): OpenAIFormatProjection {
  if (format === "json") {
    return emptyProjection({ type: "json_object" });
  }
  if (!isPlainObject(format)) {
    return emptyProjection(undefined);
  }
  if (isModelGatewayJsonSchemaFormat(format)) {
    return hasUnsupportedRootUnion(format.schema)
      ? rootUnionFallback(format.name, format.schema)
      : emptyProjection(standardJsonSchemaFormat(format));
  }
  if (format.type === "json_object") {
    rejectMisplacedProjectionMetadata(format);
    return emptyProjection({ type: "json_object" });
  }

  rejectMisplacedProjectionMetadata(format);
  if (hasUnsupportedRootUnion(format)) {
    return rootUnionFallback(OPENAI_GENERIC_SCHEMA_NAME, format);
  }
  return emptyProjection({
    type: "json_schema",
    name: OPENAI_GENERIC_SCHEMA_NAME,
    schema: format,
  });
}

export function toOpenAIResponsesTextFormat(
  format: ModelGatewayFormat | undefined,
): Record<string, unknown> | undefined {
  return projectOpenAIResponsesFormat(format).format;
}
