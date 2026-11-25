import type {
  ToolNormalInvocationInputValidation,
  ToolNormalInvocationOperation,
  ToolNormalInvocationPropertyInput,
  ToolNormalInvocationScalarInput,
} from "./contracts.js";
import { isPlainObject } from "./contract-fields.js";
import { matchesToolInputPropertyModes } from "./input-property-modes.js";

/** Deterministic post-provider validation for the exact v1 input object. */
export function validateToolNormalInvocationInput(
  operation: ToolNormalInvocationOperation,
  raw: unknown,
): ToolNormalInvocationInputValidation {
  if (!isPlainObject(raw)) return invalid("input must be an object");
  const propertyNames = Object.keys(operation.input.properties);
  const suppliedNames = Object.keys(raw);
  const unknown = suppliedNames.find((name) => !propertyNames.includes(name));
  if (unknown) return invalid(`input contains unknown property ${unknown}`);
  const missing = operation.input.required.find((name) => !Object.hasOwn(raw, name));
  if (missing) return invalid(`input is missing required property ${missing}`);
  if (!matchesToolInputPropertyModes(operation.input.anyOf, suppliedNames))
    return invalid("input properties do not match a declared mode");
  const value: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const schema = operation.input.properties[name];
    if (!schema) continue;
    const issue = validateToolNormalInvocationPropertyValue(schema, entry, `input.${name}`);
    if (issue) return invalid(issue);
    value[name] = Array.isArray(entry) ? Object.freeze([...entry]) : entry;
  }
  return Object.freeze({ ok: true as const, value: Object.freeze(value) });
}

function invalid(issue: string): ToolNormalInvocationInputValidation {
  return Object.freeze({ ok: false as const, issue });
}

function validateScalarValue(
  schema: ToolNormalInvocationScalarInput,
  value: unknown,
  path: string,
): string | undefined {
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") return `${path} must be a string`;
      if ("enum" in schema) {
        return schema.enum.includes(value)
          ? undefined
          : `${path} must be one of the declared values`;
      }
      if (value.length < schema.minLength) {
        return `${path} must contain at least ${schema.minLength} characters`;
      }
      if ("maxLength" in schema && value.length > schema.maxLength) {
        return `${path} must contain at most ${schema.maxLength} characters`;
      }
      if ("pattern" in schema && schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
        return `${path} must match its declared pattern`;
      }
      return undefined;
    case "number":
    case "integer":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (schema.type === "integer" && !Number.isSafeInteger(value))
      ) {
        return `${path} must be a ${schema.type}`;
      }
      if (value < schema.minimum) {
        return `${path} must be at least ${schema.minimum}`;
      }
      if (value > schema.maximum) {
        return `${path} must be at most ${schema.maximum}`;
      }
      return undefined;
    case "boolean":
      return typeof value === "boolean"
        ? undefined
        : `${path} must be a boolean`;
  }
}

export function validateToolNormalInvocationPropertyValue(
  schema: ToolNormalInvocationPropertyInput,
  value: unknown,
  path: string,
): string | undefined {
  if (schema.type !== "array") {
    return validateScalarValue(schema, value, path);
  }
  if (!Array.isArray(value)) return `${path} must be an array`;
  if (value.length < schema.minItems) {
    return `${path} must contain at least ${schema.minItems} items`;
  }
  if (value.length > schema.maxItems) {
    return `${path} must contain at most ${schema.maxItems} items`;
  }
  for (let index = 0; index < value.length; index += 1) {
    const issue = validateScalarValue(
      schema.items,
      value[index],
      `${path}[${index}]`,
    );
    if (issue) return issue;
  }
  return undefined;
}
