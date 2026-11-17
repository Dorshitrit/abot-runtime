import type {
  ToolNormalInvocationPropertyInput,
  ToolNormalInvocationScalarInput,
} from "./contracts.js";

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
