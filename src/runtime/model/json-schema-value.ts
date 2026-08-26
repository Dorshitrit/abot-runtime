const JSON_SCHEMA_VALIDATION_MAX_DEPTH = 32;
const JSON_SCHEMA_VALIDATION_MAX_VISITS = 50_000;
const JSON_SCHEMA_VALIDATION_MAX_ENUM_VALUES = 1_024;
const JSON_SCHEMA_DIAGNOSTIC_PATH_MAX_LENGTH = 1_024;
const JSON_SCHEMA_DIAGNOSTIC_SEGMENT_MAX_LENGTH = 128;

export type JsonSchemaValueValidationIssue = Readonly<{
  path: string;
  message: string;
}>;

type ValidationState = {
  visits: number;
};

/**
 * Post-validates the bounded, commonly used JSON Schema subset emitted to
 * model providers. Unknown keywords remain provider-owned for compatibility.
 */
export function validateJsonSchemaValue(
  schema: Readonly<Record<string, unknown>>,
  value: unknown,
): JsonSchemaValueValidationIssue | undefined {
  if (schema.type === "json_object") {
    return isPlainRecord(value)
      ? undefined
      : issue("output", "The response must be one JSON object.");
  }
  const root = unwrapSchemaFormat(schema);
  if (!root) return undefined;
  return validateNode(root, value, "output", 0, { visits: 0 });
}

function validateNode(
  schema: Readonly<Record<string, unknown>>,
  value: unknown,
  path: string,
  depth: number,
  state: ValidationState,
): JsonSchemaValueValidationIssue | undefined {
  state.visits += 1;
  if (
    depth > JSON_SCHEMA_VALIDATION_MAX_DEPTH ||
    state.visits > JSON_SCHEMA_VALIDATION_MAX_VISITS
  ) {
    return issue(path, "The JSON value is too complex to validate safely.");
  }

  if (Array.isArray(schema.enum)) {
    if (schema.enum.length > JSON_SCHEMA_VALIDATION_MAX_ENUM_VALUES) {
      return issue(path, "The declared enum is too large to validate safely.");
    }
    if (!schema.enum.some((candidate) => equalJsonValue(candidate, value))) {
      return issue(path, "The value must match one declared enum value.");
    }
  }
  if (
    Object.hasOwn(schema, "const") &&
    !equalJsonValue(schema.const, value)
  ) {
    return issue(path, "The value must match the declared constant.");
  }

  const allOfIssue = validateAllOf(schema.allOf, value, path, depth, state);
  if (allOfIssue) return allOfIssue;
  const anyOfIssue = validateAnyOf(schema.anyOf, value, path, depth, state);
  if (anyOfIssue) return anyOfIssue;
  const oneOfIssue = validateOneOf(schema.oneOf, value, path, depth, state);
  if (oneOfIssue) return oneOfIssue;

  if (!matchesDeclaredType(schema.type, value)) {
    return issue(path, "The value has the wrong JSON type.");
  }

  if (typeof value === "string") {
    const length = unicodeCodePointLength(value);
    if (isNonNegativeInteger(schema.minLength) && length < schema.minLength) {
      return issue(path, "The string is shorter than the declared minimum.");
    }
    if (isNonNegativeInteger(schema.maxLength) && length > schema.maxLength) {
      return issue(path, "The string exceeds the declared maximum length.");
    }
    return undefined;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return issue(path, "The number must be finite.");
    }
    if (schema.type === "integer" && !Number.isSafeInteger(value)) {
      return issue(path, "The value must be an integer.");
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return issue(path, "The number is below the declared minimum.");
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return issue(path, "The number exceeds the declared maximum.");
    }
    if (
      typeof schema.exclusiveMinimum === "number" &&
      value <= schema.exclusiveMinimum
    ) {
      return issue(path, "The number must exceed the declared lower bound.");
    }
    if (
      typeof schema.exclusiveMaximum === "number" &&
      value >= schema.exclusiveMaximum
    ) {
      return issue(path, "The number must be below the declared upper bound.");
    }
    return undefined;
  }

  if (Array.isArray(value)) {
    if (isNonNegativeInteger(schema.minItems) && value.length < schema.minItems) {
      return issue(path, "The array has fewer items than required.");
    }
    if (isNonNegativeInteger(schema.maxItems) && value.length > schema.maxItems) {
      return issue(path, "The array has more items than allowed.");
    }
    if (isPlainRecord(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const itemIssue = validateNode(
          schema.items,
          value[index],
          appendPath(path, String(index)),
          depth + 1,
          state,
        );
        if (itemIssue) return itemIssue;
      }
    } else if (Array.isArray(schema.items)) {
      for (let index = 0; index < Math.min(value.length, schema.items.length); index += 1) {
        const itemSchema = schema.items[index];
        if (!isPlainRecord(itemSchema)) continue;
        const itemIssue = validateNode(
          itemSchema,
          value[index],
          appendPath(path, String(index)),
          depth + 1,
          state,
        );
        if (itemIssue) return itemIssue;
      }
    }
    return undefined;
  }

  if (!isPlainRecord(value)) return undefined;
  const properties = isPlainRecord(schema.properties)
    ? schema.properties
    : undefined;
  if (Array.isArray(schema.required)) {
    for (const property of schema.required) {
      if (typeof property !== "string") continue;
      if (!Object.hasOwn(value, property)) {
        return issue(
          appendPath(path, property),
          "A required property is missing.",
        );
      }
    }
  }
  if (properties) {
    for (const [property, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, property) || !isPlainRecord(propertySchema)) {
        continue;
      }
      const propertyIssue = validateNode(
        propertySchema,
        value[property],
        appendPath(path, property),
        depth + 1,
        state,
      );
      if (propertyIssue) return propertyIssue;
    }
  }
  for (const [property, propertyValue] of Object.entries(value)) {
    if (properties && Object.hasOwn(properties, property)) continue;
    if (schema.additionalProperties === false) {
      return issue(
        path,
        "The property is not declared by the response format.",
      );
    }
    if (isPlainRecord(schema.additionalProperties)) {
      const additionalIssue = validateNode(
        schema.additionalProperties,
        propertyValue,
        path,
        depth + 1,
        state,
      );
      if (additionalIssue) return additionalIssue;
    }
  }
  return undefined;
}

function validateAllOf(
  input: unknown,
  value: unknown,
  path: string,
  depth: number,
  state: ValidationState,
): JsonSchemaValueValidationIssue | undefined {
  if (!Array.isArray(input)) return undefined;
  for (const schema of input) {
    if (!isPlainRecord(schema)) continue;
    const branchIssue = validateNode(schema, value, path, depth + 1, state);
    if (branchIssue) return branchIssue;
  }
  return undefined;
}

function validateAnyOf(
  input: unknown,
  value: unknown,
  path: string,
  depth: number,
  state: ValidationState,
): JsonSchemaValueValidationIssue | undefined {
  if (!Array.isArray(input)) return undefined;
  const branches = input.filter(isPlainRecord);
  if (branches.length === 0) return undefined;
  for (const schema of branches) {
    if (!validateNode(schema, value, path, depth + 1, state)) return undefined;
  }
  return issue(path, "The value must match at least one allowed schema.");
}

function validateOneOf(
  input: unknown,
  value: unknown,
  path: string,
  depth: number,
  state: ValidationState,
): JsonSchemaValueValidationIssue | undefined {
  if (!Array.isArray(input)) return undefined;
  const branches = input.filter(isPlainRecord);
  if (branches.length === 0) return undefined;
  let matches = 0;
  for (const schema of branches) {
    if (!validateNode(schema, value, path, depth + 1, state)) matches += 1;
  }
  return matches === 1
    ? undefined
    : issue(path, "The value must match exactly one allowed schema.");
}

function matchesDeclaredType(type: unknown, value: unknown): boolean {
  if (typeof type === "string") return matchesType(type, value);
  if (Array.isArray(type)) {
    const declared = type.filter(
      (entry): entry is string => typeof entry === "string",
    );
    return declared.length === 0 || declared.some((entry) => matchesType(entry, value));
  }
  return true;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function unwrapSchemaFormat(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  if (input.type === "json_schema" && isPlainRecord(input.schema)) {
    return input.schema;
  }
  return input;
}

function equalJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => equalJsonValue(value, right[index]))
    );
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) && equalJsonValue(left[key], right[key]),
    )
  );
}

function appendPath(path: string, segment: string): string {
  const boundedSegment = segment
    .slice(0, JSON_SCHEMA_DIAGNOSTIC_SEGMENT_MAX_LENGTH)
    .replace(/~/gu, "~0")
    .replace(/\//gu, "~1");
  return `${path}/${boundedSegment}`.slice(
    0,
    JSON_SCHEMA_DIAGNOSTIC_PATH_MAX_LENGTH,
  );
}

function issue(path: string, message: string): JsonSchemaValueValidationIssue {
  return Object.freeze({ path, message });
}

function isNonNegativeInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) >= 0;
}

function unicodeCodePointLength(input: string): number {
  let length = 0;
  for (const _character of input) length += 1;
  return length;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
