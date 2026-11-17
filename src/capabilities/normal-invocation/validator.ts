import { boundedInteger, boundedText, fail, hasExactKeys, identifier, isPlainObject } from "./contract-fields.js";
import { parseToolNormalInvocationInputSchema } from "./input-schema.js";
import { validateToolNormalInvocationPropertyValue } from "./input-value.js";
import { parseOptionalToolOutputChannels } from "./output-channels.js";
import {
  TOOL_NORMAL_INVOCATION_STRING_MAX_LENGTH as MAX_STRING_LENGTH_BOUND,
  TOOL_NORMAL_INVOCATION_PAYLOAD_MAX_BYTES,
  TOOL_NORMAL_INVOCATION_VERSION,
  TOOL_NORMAL_INVOCATION_INPUT_MAX_PROPERTIES as MAX_PROPERTIES,
  type ToolNormalInvocationAttachmentInput,
  type ToolNormalInvocationContract,
  type ToolNormalInvocationFixedValue,
  type ToolNormalInvocationInput,
  type ToolNormalInvocationInputValidation,
  type ToolNormalInvocationOperation,
  type ToolNormalInvocationPropertyInput,
} from "./contracts.js";

const MAX_OPERATIONS = 32;
const MAX_SUMMARY_LENGTH = 512;
const MAX_INSTRUCTIONS_LENGTH = 1_024;
const MAX_FIXED_PARAMS = 16;

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

function parseAttachmentInput(
  toolName: string,
  path: string,
  input: ToolNormalInvocationInput,
  value: unknown,
): ToolNormalInvocationAttachmentInput | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value) ||
      !hasExactKeys(value, ["param", "acceptedMimeTypes"], ["mode"]))
    fail(toolName, path, "expected param, acceptedMimeTypes and optional mode");
  const param = identifier(toolName, `${path}.param`, value.param);
  const source = input.properties[param];
  if (!source || source.type !== "string")
    fail(toolName, `${path}.param`, "expected a string input property");
  const rawTypes = value.acceptedMimeTypes;
  if (!Array.isArray(rawTypes) || rawTypes.length < 1 || rawTypes.length > 32 ||
      rawTypes.some((mime) => typeof mime !== "string" ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime)) ||
      new Set(rawTypes).size !== rawTypes.length)
    fail(toolName, `${path}.acceptedMimeTypes`, "expected 1-32 distinct MIME types");
  let mode: ToolNormalInvocationAttachmentInput["mode"];
  if (value.mode !== undefined) {
    if (!isPlainObject(value.mode) ||
        !hasExactKeys(value.mode, ["param", "value"]))
      fail(toolName, `${path}.mode`, "expected param and value");
    const modeParam = identifier(toolName, `${path}.mode.param`, value.mode.param);
    const modeValue = identifier(toolName, `${path}.mode.value`, value.mode.value);
    const modeInput = input.properties[modeParam];
    if (!modeInput || modeInput.type !== "string" ||
        ("enum" in modeInput && !modeInput.enum.includes(modeValue)))
      fail(toolName, `${path}.mode`, "expected a permitted string input value");
    mode = Object.freeze({ param: modeParam, value: modeValue });
  }
  return Object.freeze({
    param,
    acceptedMimeTypes: Object.freeze([...rawTypes] as string[]),
    ...(mode ? { mode } : {}),
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
      ["selectionControlIds", "fixedParams", "payload", "attachmentInput", "outputChannels"],
    )
  ) {
    fail(
      toolName,
      path,
      "operation must contain operationId/summary/input/effect/approval and optional selectionControlIds/fixedParams/payload/attachmentInput/outputChannels",
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
  const input = parseToolNormalInvocationInputSchema(toolName, `${path}.input`, raw.input);
  const selectionControlIds = parseSelectionControlIds(
    toolName,
    `${path}.selectionControlIds`,
    input,
    raw.selectionControlIds,
  );
  const fixedParams = parseFixedParams(
    toolName,
    `${path}.fixedParams`,
    raw.fixedParams,
  );
  const payload = parsePayload(toolName, `${path}.payload`, raw.payload);
  const attachmentInput = parseAttachmentInput(
    toolName, `${path}.attachmentInput`, input, raw.attachmentInput,
  );
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
    summary: boundedText(toolName, `${path}.summary`, raw.summary, MAX_SUMMARY_LENGTH),
    ...parseOptionalToolOutputChannels(raw.outputChannels, `${toolName}.${path}.outputChannels`),
    input,
    ...(selectionControlIds ? { selectionControlIds } : {}),
    ...(fixedParams ? { fixedParams } : {}),
    ...(payload ? { payload } : {}),
    ...(attachmentInput ? { attachmentInput } : {}),
    effect: raw.effect,
    approval: raw.approval,
  });
}

function parseSelectionControlIds(
  toolName: string,
  path: string,
  input: ToolNormalInvocationInput,
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_PROPERTIES
  ) {
    fail(
      toolName,
      path,
      `expected a non-empty array of at most ${MAX_PROPERTIES} control identifiers`,
    );
  }
  const controlIds = value.map((controlId, index) =>
    identifier(toolName, `${path}.${index}`, controlId),
  );
  if (new Set(controlIds).size !== controlIds.length) {
    fail(toolName, path, "expected unique control identifiers");
  }
  for (const controlId of controlIds) {
    if (!Object.hasOwn(input.properties, controlId)) {
      fail(toolName, path, `unknown input control ${controlId}`);
    }
    if (!input.required.includes(controlId)) {
      fail(toolName, path, `selection control ${controlId} must be required`);
    }
  }
  return Object.freeze(controlIds);
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
  payloadChannelSpec?: Readonly<{
    stages?: readonly Readonly<{ outputParam: string }>[];
  }>;
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
  const stagedOutputParams =
    definition.payloadChannelSpec?.stages &&
    definition.payloadChannelSpec.stages.length >= 2
      ? new Set(
          definition.payloadChannelSpec.stages.map(
            ({ outputParam }) => outputParam,
          ),
        )
      : undefined;
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
    for (const selectionControlId of operation.selectionControlIds ?? []) {
      if (stagedOutputParams?.has(selectionControlId)) {
        fail(
          definition.name,
          `${operationPath}.selectionControlIds`,
          `selection control ${selectionControlId} must remain in the effective public input`,
        );
      }
    }
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
    const issue = validateToolNormalInvocationPropertyValue(schema, entry, `input.${name}`);
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
