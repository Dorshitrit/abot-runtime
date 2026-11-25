import {
  TOOL_NORMAL_INVOCATION_STRING_MAX_LENGTH as MAX_STRING_LENGTH_BOUND,
  TOOL_NORMAL_INVOCATION_INPUT_MAX_PROPERTIES as MAX_PROPERTIES,
  type ToolNormalInvocationArrayInput,
  type ToolNormalInvocationInput,
  type ToolNormalInvocationPropertyInput,
  type ToolNormalInvocationScalarInput,
} from "./contracts.js";
import {
  boundedInteger,
  fail,
  finiteNumber,
  hasExactKeys,
  identifier,
  isFixedWidthInputPattern,
  isPlainObject,
} from "./contract-fields.js";
import { normalizeToolInputDocumentation } from "./input-documentation.js";
import { normalizeToolInputPropertyModes } from "./input-property-modes.js";

const MAX_ENUM_VALUES = 64;
const MAX_ENUM_VALUE_LENGTH = 256;
const MAX_ARRAY_ITEMS_BOUND = 64;

function parseStringInput(
  toolName: string,
  path: string,
  raw: Record<string, unknown>,
): ToolNormalInvocationScalarInput {
  if ("enum" in raw) {
    if (!hasExactKeys(raw, ["type", "enum"])) {
      fail(
        toolName,
        path,
        "string enum input must contain exactly type and enum",
      );
    }
    if (
      !Array.isArray(raw.enum) ||
      raw.enum.length === 0 ||
      raw.enum.length > MAX_ENUM_VALUES ||
      raw.enum.some(
        (value) =>
          typeof value !== "string" || value.length > MAX_ENUM_VALUE_LENGTH,
      ) ||
      new Set(raw.enum).size !== raw.enum.length
    ) {
      fail(
        toolName,
        `${path}.enum`,
        `expected 1-${MAX_ENUM_VALUES} unique strings of at most ${MAX_ENUM_VALUE_LENGTH} characters`,
      );
    }
    return Object.freeze({
      type: "string" as const,
      enum: Object.freeze(raw.enum.map((value) => value as string)),
    });
  }
  if (!Object.hasOwn(raw, "maxLength")) {
    if (!hasExactKeys(raw, ["type", "minLength"])) {
      fail(
        toolName,
        path,
        "unbounded string input must contain exactly type and minLength",
      );
    }
    return Object.freeze({
      type: "string" as const,
      minLength: boundedInteger(
        toolName,
        `${path}.minLength`,
        raw.minLength,
        0,
        MAX_STRING_LENGTH_BOUND,
      ),
    });
  }
  if (!hasExactKeys(raw, ["type", "minLength", "maxLength"], ["pattern"])) {
    fail(
      toolName,
      path,
      "bounded string input must contain exactly type, minLength, maxLength and, optionally, pattern",
    );
  }
  const pattern = raw.pattern;
  if (Object.hasOwn(raw, "pattern") && !isFixedWidthInputPattern(pattern)) {
    fail(toolName, `${path}.pattern`, "expected an anchored, fixed-width string pattern");
  }
  const minLength = boundedInteger(
    toolName,
    `${path}.minLength`,
    raw.minLength,
    0,
    MAX_STRING_LENGTH_BOUND,
  );
  const maxLength = boundedInteger(
    toolName,
    `${path}.maxLength`,
    raw.maxLength,
    1,
    MAX_STRING_LENGTH_BOUND,
  );
  if (minLength > maxLength) {
    fail(toolName, path, "minLength must not exceed maxLength");
  }
  return Object.freeze({
    type: "string" as const,
    minLength,
    maxLength,
    ...(typeof pattern === "string" ? { pattern } : {}),
  });
}

function parseNumberInput(
  toolName: string,
  path: string,
  raw: Record<string, unknown>,
): ToolNormalInvocationScalarInput {
  if (!hasExactKeys(raw, ["type", "minimum", "maximum"])) {
    fail(
      toolName,
      path,
      "numeric input must contain exactly type, minimum and maximum",
    );
  }
  const minimum = finiteNumber(toolName, `${path}.minimum`, raw.minimum);
  const maximum = finiteNumber(toolName, `${path}.maximum`, raw.maximum);
  if (minimum > maximum) {
    fail(toolName, path, "minimum must not exceed maximum");
  }
  if (
    raw.type === "integer" &&
    (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum))
  ) {
    fail(toolName, path, "integer bounds must be safe integers");
  }
  return Object.freeze({
    type: raw.type as "number" | "integer",
    minimum,
    maximum,
  });
}

function parseBooleanInput(
  toolName: string,
  path: string,
  raw: Record<string, unknown>,
): ToolNormalInvocationScalarInput {
  if (!hasExactKeys(raw, ["type"])) {
    fail(toolName, path, "boolean input must contain exactly type");
  }
  return Object.freeze({
    type: "boolean" as const,
  });
}

function parseScalarInput(
  toolName: string,
  path: string,
  raw: unknown,
): ToolNormalInvocationScalarInput {
  if (!isPlainObject(raw)) {
    fail(toolName, path, "expected a scalar input schema object");
  }
  switch (raw.type) {
    case "string":
      return parseStringInput(toolName, path, raw);
    case "number":
    case "integer":
      return parseNumberInput(toolName, path, raw);
    case "boolean":
      return parseBooleanInput(toolName, path, raw);
    default:
      fail(
        toolName,
        `${path}.type`,
        "expected string, number, integer or boolean",
      );
  }
}

function parseArrayInput(
  toolName: string,
  path: string,
  raw: Record<string, unknown>,
): ToolNormalInvocationArrayInput {
  if (!hasExactKeys(raw, ["type", "items", "minItems", "maxItems"])) {
    fail(
      toolName,
      path,
      "array input must contain exactly type, items, minItems and maxItems",
    );
  }
  const minItems = boundedInteger(
    toolName,
    `${path}.minItems`,
    raw.minItems,
    0,
    MAX_ARRAY_ITEMS_BOUND,
  );
  const maxItems = boundedInteger(
    toolName,
    `${path}.maxItems`,
    raw.maxItems,
    1,
    MAX_ARRAY_ITEMS_BOUND,
  );
  if (minItems > maxItems) {
    fail(toolName, path, "minItems must not exceed maxItems");
  }
  return Object.freeze({
    type: "array" as const,
    items: parseScalarInput(toolName, `${path}.items`, raw.items),
    minItems,
    maxItems,
  });
}

function parsePropertyInput(
  toolName: string,
  path: string,
  raw: unknown,
): ToolNormalInvocationPropertyInput {
  if (!isPlainObject(raw)) {
    fail(toolName, path, "expected an input schema object");
  }
  const { description: _description, example: _example, ...structural } = raw;
  const schema =
    structural.type === "array"
      ? parseArrayInput(toolName, path, structural)
      : parseScalarInput(toolName, path, structural);
  const documentation = normalizeToolInputDocumentation(
    Object.fromEntries(
      Object.entries(raw).filter(
        ([key]) => key === "description" || key === "example",
      ),
    ),
    schema,
  );
  if (!documentation.ok) fail(toolName, path, documentation.issue);
  return Object.freeze({ ...schema, ...documentation.value });
}

export function parseToolNormalInvocationInputSchema(
  toolName: string,
  path: string,
  raw: unknown,
): ToolNormalInvocationInput {
  if (
    !isPlainObject(raw) ||
    !hasExactKeys(raw, [
      "type",
      "additionalProperties",
      "properties",
      "required",
    ], ["anyOf"]) ||
    raw.type !== "object" ||
    raw.additionalProperties !== false ||
    !isPlainObject(raw.properties) ||
    !Array.isArray(raw.required)
  ) {
    fail(
      toolName,
      path,
      "expected an exact object schema with type/properties/required/additionalProperties:false",
    );
  }
  const propertyEntries = Object.entries(raw.properties);
  if (propertyEntries.length > MAX_PROPERTIES) {
    fail(
      toolName,
      `${path}.properties`,
      `may contain at most ${MAX_PROPERTIES} properties`,
    );
  }
  const properties: Record<string, ToolNormalInvocationPropertyInput> = {};
  for (const [propertyName, propertySchema] of propertyEntries) {
    const name = identifier(
      toolName,
      `${path}.properties.${propertyName}`,
      propertyName,
    );
    properties[name] = parsePropertyInput(
      toolName,
      `${path}.properties.${name}`,
      propertySchema,
    );
  }
  if (
    raw.required.some((name) => typeof name !== "string") ||
    new Set(raw.required).size !== raw.required.length
  ) {
    fail(toolName, `${path}.required`, "expected unique property names");
  }
  const required = raw.required.map((name) => name as string);
  const unknownRequired = required.find(
    (name) => !Object.hasOwn(properties, name),
  );
  if (unknownRequired) {
    fail(
      toolName,
      `${path}.required`,
      `references unknown property ${unknownRequired}`,
    );
  }
  const modes = normalizeToolInputPropertyModes(raw.anyOf, Object.keys(properties), required);
  if (!modes.ok) fail(toolName, `${path}.anyOf`, modes.issue);
  if (Object.hasOwn(raw, "anyOf") && modes.value === undefined)
    fail(toolName, `${path}.anyOf`, "expected a property-name mode array");
  return Object.freeze({
    type: "object" as const,
    additionalProperties: false as const,
    properties: Object.freeze(properties),
    required: Object.freeze(required),
    ...(modes.value ? { anyOf: modes.value } : {}),
  });
}
