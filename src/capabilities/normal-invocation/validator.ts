import {
  TOOL_NORMAL_INVOCATION_IDENTIFIER_MAX_LENGTH,
  TOOL_NORMAL_INVOCATION_PAYLOAD_MAX_BYTES,
  TOOL_NORMAL_INVOCATION_VERSION,
  type ToolNormalInvocationArrayInput,
  type ToolNormalInvocationContract,
  type ToolNormalInvocationFixedValue,
  type ToolNormalInvocationInput,
  type ToolNormalInvocationInputValidation,
  type ToolNormalInvocationOperation,
  type ToolNormalInvocationPropertyInput,
  type ToolNormalInvocationScalarInput,
} from "./contracts.js";

const MAX_OPERATIONS = 16;
const MAX_SUMMARY_LENGTH = 512;
const MAX_INSTRUCTIONS_LENGTH = 1_024;
const MAX_PROPERTIES = 16;
const MAX_FIXED_PARAMS = 16;
const MAX_STRING_LENGTH_BOUND = 4_096;
const MAX_ENUM_VALUES = 64;
const MAX_ENUM_VALUE_LENGTH = 256;
const MAX_ARRAY_ITEMS_BOUND = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function fail(toolName: string, path: string, issue: string): never {
  throw new Error(
    `Invalid normal invocation contract for ${toolName} (${path}: ${issue})`,
  );
}

function boundedText(
  toolName: string,
  path: string,
  value: unknown,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    fail(
      toolName,
      path,
      `expected non-empty text of at most ${maxLength} characters`,
    );
  }
  return value.trim();
}

function identifier(toolName: string, path: string, value: unknown): string {
  const parsed = boundedText(
    toolName,
    path,
    value,
    TOOL_NORMAL_INVOCATION_IDENTIFIER_MAX_LENGTH,
  );
  if (/^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u.test(parsed) === false) {
    fail(
      toolName,
      path,
      "expected an identifier containing only letters, numbers, '.', '_', ':' or '-'",
    );
  }
  return parsed;
}

function boundedInteger(
  toolName: string,
  path: string,
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(
      toolName,
      path,
      `expected a safe integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function finiteNumber(toolName: string, path: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(toolName, path, "expected a finite number");
  }
  return value;
}

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
  if (!hasExactKeys(raw, ["type", "minLength", "maxLength"])) {
    fail(
      toolName,
      path,
      "bounded string input must contain exactly type, minLength and maxLength",
    );
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
  return raw.type === "array"
    ? parseArrayInput(toolName, path, raw)
    : parseScalarInput(toolName, path, raw);
}

function parseInput(
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
    ]) ||
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
  return Object.freeze({
    type: "object" as const,
    additionalProperties: false as const,
    properties: Object.freeze(properties),
    required: Object.freeze(required),
  });
}

function parseFixedParams(
  toolName: string,
  path: string,
  raw: unknown,
): Readonly<Record<string, ToolNormalInvocationFixedValue>> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    fail(toolName, path, "expected a non-empty object of scalar fixed values");
  }
  if (Object.keys(raw).length > MAX_FIXED_PARAMS) {
    fail(
      toolName,
      path,
      `may contain at most ${MAX_FIXED_PARAMS} fixed parameters`,
    );
  }
  const fixed: Record<string, ToolNormalInvocationFixedValue> = {};
  for (const [rawName, value] of Object.entries(raw)) {
    const name = identifier(toolName, `${path}.${rawName}`, rawName);
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      fail(
        toolName,
        `${path}.${name}`,
        "expected a string, finite number or boolean",
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      fail(toolName, `${path}.${name}`, "expected a finite number");
    }
    if (typeof value === "string" && value.length > MAX_STRING_LENGTH_BOUND) {
      fail(
        toolName,
        `${path}.${name}`,
        `expected at most ${MAX_STRING_LENGTH_BOUND} characters`,
      );
    }
    fixed[name] = value;
  }
  return Object.freeze(fixed);
}

function parsePayload(
  toolName: string,
  path: string,
  raw: unknown,
): ToolNormalInvocationOperation["payload"] {
  if (raw === undefined) return undefined;
  if (
    !isPlainObject(raw) ||
    !hasExactKeys(
      raw,
      ["kind", "param", "instructions", "maxBytes"],
      ["minBytes"],
    ) ||
    raw.kind !== "raw_text"
  ) {
    fail(
      toolName,
      path,
      "expected kind/raw_text, param, instructions, maxBytes and optional minBytes",
    );
  }
  const maxBytes = boundedInteger(
    toolName,
    `${path}.maxBytes`,
    raw.maxBytes,
    1,
    TOOL_NORMAL_INVOCATION_PAYLOAD_MAX_BYTES,
  );
  const minBytes =
    raw.minBytes === undefined
      ? undefined
      : boundedInteger(
          toolName,
          `${path}.minBytes`,
          raw.minBytes,
          0,
          TOOL_NORMAL_INVOCATION_PAYLOAD_MAX_BYTES,
        );
  if (minBytes !== undefined && minBytes > maxBytes) {
    fail(
      toolName,
      `${path}.minBytes`,
      "expected minBytes not to exceed maxBytes",
    );
  }
  return Object.freeze({
    kind: "raw_text" as const,
    param: identifier(toolName, `${path}.param`, raw.param),
    instructions: boundedText(
      toolName,
      `${path}.instructions`,
      raw.instructions,
      MAX_INSTRUCTIONS_LENGTH,
    ),
    ...(minBytes === undefined ? {} : { minBytes }),
    maxBytes,
  });
}

function parseOperation(
  toolName: string,
  path: string,
  raw: unknown,
): ToolNormalInvocationOperation {
  if (
    !isPlainObject(raw) ||
    !hasExactKeys(
      raw,
      ["operationId", "summary", "input", "effect", "approval"],
      ["fixedParams", "payload"],
    )
  ) {
    fail(
      toolName,
      path,
      "operation must contain operationId/summary/input/effect/approval and optional fixedParams/payload",
    );
  }
  if (
    raw.effect !== "read_only" &&
    raw.effect !== "mutating" &&
    raw.effect !== "mixed"
  ) {
    fail(toolName, `${path}.effect`, "expected read_only, mutating or mixed");
  }
  if (raw.approval !== "request_policy" && raw.approval !== "always") {
    fail(toolName, `${path}.approval`, "expected request_policy or always");
  }
  const input = parseInput(toolName, `${path}.input`, raw.input);
  const fixedParams = parseFixedParams(
    toolName,
    `${path}.fixedParams`,
    raw.fixedParams,
  );
  const payload = parsePayload(toolName, `${path}.payload`, raw.payload);
  const overlaps = new Set(Object.keys(input.properties));
  for (const fixedName of Object.keys(fixedParams ?? {})) {
    if (overlaps.has(fixedName)) {
      fail(
        toolName,
        path,
        `parameter ${fixedName} cannot be both input and fixed`,
      );
    }
    overlaps.add(fixedName);
  }
  if (payload && overlaps.has(payload.param)) {
    fail(
      toolName,
      path,
      `payload parameter ${payload.param} must be separate from input and fixed params`,
    );
  }
  return Object.freeze({
    operationId: identifier(toolName, `${path}.operationId`, raw.operationId),
    summary: boundedText(
      toolName,
      `${path}.summary`,
      raw.summary,
      MAX_SUMMARY_LENGTH,
    ),
    input,
    ...(fixedParams ? { fixedParams } : {}),
    ...(payload ? { payload } : {}),
    effect: raw.effect,
    approval: raw.approval,
  });
}

export function parseToolNormalInvocationContract(
  toolName: string,
  raw: unknown,
): ToolNormalInvocationContract | undefined {
  if (raw === undefined) return undefined;
  if (
    !isPlainObject(raw) ||
    !hasExactKeys(raw, ["version", "operations"]) ||
    raw.version !== TOOL_NORMAL_INVOCATION_VERSION ||
    !Array.isArray(raw.operations) ||
    raw.operations.length === 0 ||
    raw.operations.length > MAX_OPERATIONS
  ) {
    fail(
      toolName,
      "normalInvocation",
      `expected exactly version:${TOOL_NORMAL_INVOCATION_VERSION} and 1-${MAX_OPERATIONS} operations`,
    );
  }
  const operations = raw.operations.map((operation, index) =>
    parseOperation(toolName, `normalInvocation.operations.${index}`, operation),
  );
  const seen = new Set<string>();
  for (const operation of operations) {
    if (seen.has(operation.operationId)) {
      fail(
        toolName,
        "normalInvocation.operations",
        `duplicate operationId ${operation.operationId}`,
      );
    }
    seen.add(operation.operationId);
  }
  return Object.freeze({
    version: TOOL_NORMAL_INVOCATION_VERSION,
    operations: Object.freeze(operations),
  });
}

type ToolNormalInvocationDefinition = Readonly<{
  name: string;
  params: Readonly<Record<string, string>>;
  executionEffect?: "read_only" | "mutating" | "mixed";
  runtimePathBindings?: readonly Readonly<{
    operationId: string;
    param: string;
    base: "worker_working_directory";
    default?: ".";
  }>[];
}>;

function projectedTypeForSchema(
  schema: ToolNormalInvocationPropertyInput,
): readonly string[] {
  if (schema.type === "array") {
    switch (schema.items.type) {
      case "string":
        return ["string[]"];
      case "number":
        return ["number[]"];
      case "integer":
        return ["integer[]", "number[]"];
      case "boolean":
        return ["boolean[]"];
    }
  }
  switch (schema.type) {
    case "string":
      return ["string"];
    case "number":
      return ["number"];
    case "integer":
      return ["integer", "number"];
    case "boolean":
      return ["boolean"];
  }
}

function projectedTypeForFixedValue(
  value: ToolNormalInvocationFixedValue,
): readonly string[] {
  switch (typeof value) {
    case "string":
      return ["string"];
    case "number":
      return Number.isSafeInteger(value) ? ["integer", "number"] : ["number"];
    case "boolean":
      return ["boolean"];
  }
}

function validateDeclaredParam(
  definition: ToolNormalInvocationDefinition,
  path: string,
  param: string,
  compatibleTypes: readonly string[],
): void {
  if (!Object.hasOwn(definition.params, param)) {
    fail(
      definition.name,
      path,
      `parameter ${param} is not declared in definition.params`,
    );
  }
  const declaredType = definition.params[param]!;
  if (!compatibleTypes.includes(declaredType)) {
    fail(
      definition.name,
      path,
      `parameter ${param} requires projected type ${compatibleTypes.join(" or ")}, received ${declaredType}`,
    );
  }
}

/**
 * Parses the closed contract and binds it to its derived public definition.
 * This is the registry-loading entry point; it prevents a plugin contract from
 * advertising inputs that its registered implementation cannot receive.
 */
export function parseToolNormalInvocationForDefinition(
  definition: ToolNormalInvocationDefinition,
  raw: unknown,
): ToolNormalInvocationContract | undefined {
  const contract = parseToolNormalInvocationContract(definition.name, raw);
  if (!contract) return undefined;
  for (const [bindingIndex, binding] of (
    definition.runtimePathBindings ?? []
  ).entries()) {
    const operation = contract.operations.find(
      (candidate) => candidate.operationId === binding.operationId,
    );
    const input = operation?.input.properties[binding.param];
    if (
      !operation ||
      !input ||
      input.type !== "string" ||
      (!operation.input.required.includes(binding.param) &&
        binding.default === undefined) ||
      operation.fixedParams?.[binding.param] !== undefined
    ) {
      fail(
        definition.name,
        `runtimePathBindings.${bindingIndex}`,
        `binding ${binding.operationId}.${binding.param} must identify one required public string operation input`,
      );
    }
  }
  for (const [operationIndex, operation] of contract.operations.entries()) {
    const operationPath = `normalInvocation.operations.${operationIndex}`;
    for (const [param, schema] of Object.entries(operation.input.properties)) {
      validateDeclaredParam(
        definition,
        `${operationPath}.input.properties.${param}`,
        param,
        projectedTypeForSchema(schema),
      );
    }
    for (const [param, value] of Object.entries(operation.fixedParams ?? {})) {
      validateDeclaredParam(
        definition,
        `${operationPath}.fixedParams.${param}`,
        param,
        projectedTypeForFixedValue(value),
      );
    }
    if (operation.payload) {
      validateDeclaredParam(
        definition,
        `${operationPath}.payload.param`,
        operation.payload.param,
        ["string"],
      );
    }
    if (
      definition.executionEffect !== undefined &&
      definition.executionEffect !== "mixed" &&
      definition.executionEffect !== operation.effect
    ) {
      fail(
        definition.name,
        `${operationPath}.effect`,
        `effect ${operation.effect} does not match definition.executionEffect ${definition.executionEffect}`,
      );
    }
  }
  return contract;
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

function validatePropertyValue(
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

/** Deterministic post-provider validation for the exact v1 input object. */
export function validateToolNormalInvocationInput(
  operation: ToolNormalInvocationOperation,
  raw: unknown,
): ToolNormalInvocationInputValidation {
  if (!isPlainObject(raw)) return invalid("input must be an object");
  const propertyNames = Object.keys(operation.input.properties);
  const unknown = Object.keys(raw).find(
    (name) => !propertyNames.includes(name),
  );
  if (unknown) return invalid(`input contains unknown property ${unknown}`);
  const missing = operation.input.required.find(
    (name) => !Object.hasOwn(raw, name),
  );
  if (missing) return invalid(`input is missing required property ${missing}`);
  const value: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const schema = operation.input.properties[name];
    if (!schema) continue;
    const issue = validatePropertyValue(schema, entry, `input.${name}`);
    if (issue) return invalid(issue);
    value[name] = Array.isArray(entry) ? Object.freeze([...entry]) : entry;
  }
  return Object.freeze({
    ok: true as const,
    value: Object.freeze(value),
  });
}

export function validateToolNormalInvocationPayload(
  operation: ToolNormalInvocationOperation,
  raw: unknown,
): string | undefined {
  if (!operation.payload) {
    return raw === undefined
      ? undefined
      : "operation does not accept a payload";
  }
  if (typeof raw !== "string") return "payload must be raw text";
  const bytes = new TextEncoder().encode(raw).byteLength;
  const minBytes = operation.payload.minBytes ?? 0;
  if (bytes < minBytes) {
    return `payload is smaller than ${minBytes} bytes`;
  }
  return bytes > operation.payload.maxBytes
    ? `payload exceeds ${operation.payload.maxBytes} bytes`
    : undefined;
}
