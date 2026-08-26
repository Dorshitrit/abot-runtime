import {
  ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX,
  ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
} from "../role-calls/contracts.js";

export const CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES = 256 * 1024;

export type CapabilityJsonPrimitive = string | number | boolean | null;
export type CapabilityJsonValue =
  | CapabilityJsonPrimitive
  | readonly CapabilityJsonValue[]
  | CapabilityJsonObject;

export interface CapabilityJsonObject {
  readonly [key: string]: CapabilityJsonValue;
}

export type CapabilityResultReference = Readonly<{
  kind: "tool_target";
  target: string;
}>;

export type CanonicalToolExecutionResult = Readonly<{
  ok: boolean;
  tool: string;
  output: string;
  progress?: boolean;
  producedNewInformation: boolean;
  actions?: readonly Readonly<{
    type: string;
    target?: string;
    details?: string;
  }>[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  data?: CapabilityJsonObject;
  error?: string;
  errorCode?: string;
}>;

export type RegisteredToolCapabilityResult = Readonly<{
  kind: "registered_tool_execution_result_v1";
  authority: "registered_plugin";
  status: "executed";
  /** Exact JSON-safe ToolExecutionResult returned by the registered plugin. */
  result: CanonicalToolExecutionResult;
  references?: readonly CapabilityResultReference[];
}>;

export type RuntimeCapabilityRejectionResult = Readonly<{
  kind: "runtime_capability_rejection_v1";
  authority: "runtime";
  status: "rejected";
  stage: "before_external_execution";
  code: string;
  message: string;
  references?: readonly CapabilityResultReference[];
}>;

export type GenericCapabilityAdapterResult = Readonly<{
  kind: "generic_capability_result_v1";
  authority: "capability_adapter";
  status: "executed";
  ok: boolean;
  /** Exact JSON-safe adapter-owned payload; runtime assigns no semantics. */
  payload: CapabilityJsonValue;
  references?: readonly CapabilityResultReference[];
}>;

export type CapabilityAdapterResult =
  | RegisteredToolCapabilityResult
  | RuntimeCapabilityRejectionResult
  | GenericCapabilityAdapterResult;

export type CapabilityAdapterResultNormalization =
  | Readonly<{ ok: true; value: CapabilityAdapterResult }>
  | Readonly<{
      ok: false;
      code: "result_invalid" | "result_not_json_safe" | "result_too_large";
    }>;

/**
 * Captures one typed exact result without truncating or semantically rewriting
 * plugin-authored content. Bounds come from the explicit envelope schema and
 * the hard serialized-result producer limit.
 */
export function normalizeCapabilityAdapterResult(
  input: unknown,
): CapabilityAdapterResultNormalization {
  try {
    const normalized = normalizeCanonicalResult(input);
    return normalized
      ? acceptBoundedResult(normalized)
      : invalid("result_invalid");
  } catch {
    return invalid("result_not_json_safe");
  }
}

/**
 * Compatibility bridge for custom adapters that still implement the legacy
 * Worker result contract. The original adapter payload is captured exactly
 * inside a generic envelope for every authorized principal.
 */
export function captureLegacyCapabilityAdapterResult(
  input: unknown,
): CapabilityAdapterResultNormalization {
  try {
    return captureLegacyCapabilityAdapterResultUnsafe(input);
  } catch {
    return invalid("result_not_json_safe");
  }
}

function captureLegacyCapabilityAdapterResultUnsafe(
  input: unknown,
): CapabilityAdapterResultNormalization {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(
      input,
      ["outcome", "observedEffect", "summary"],
      ["referenceData", "references", "exactResult"],
    ) ||
    (input.outcome !== "succeeded" && input.outcome !== "failed") ||
    (input.observedEffect !== "none" &&
      input.observedEffect !== "observation" &&
      input.observedEffect !== "mutation" &&
      input.observedEffect !== "indeterminate") ||
    typeof input.summary !== "string" ||
    (input.referenceData !== undefined &&
      typeof input.referenceData !== "string")
  ) {
    return invalid("result_invalid");
  }
  const references = normalizeReferences(input.references);
  const payload = captureJsonValue({
    outcome: input.outcome,
    observedEffect: input.observedEffect,
    summary: input.summary,
    ...(input.referenceData === undefined
      ? {}
      : { referenceData: input.referenceData }),
  });
  if (references === null || payload === undefined) {
    return invalid("result_not_json_safe");
  }
  return acceptBoundedResult(
    Object.freeze({
      kind: "generic_capability_result_v1" as const,
      authority: "capability_adapter" as const,
      status: "executed" as const,
      ok: input.outcome === "succeeded",
      payload,
      ...(references ? { references } : {}),
    }),
  );
}

function normalizeCanonicalResult(
  input: unknown,
): CapabilityAdapterResult | undefined {
  if (!isPlainRecord(input)) return undefined;
  switch (input.kind) {
    case "registered_tool_execution_result_v1":
      return normalizeRegisteredToolResult(input);
    case "runtime_capability_rejection_v1":
      return normalizeRuntimeRejection(input);
    case "generic_capability_result_v1":
      return normalizeGenericResult(input);
    default:
      return undefined;
  }
}

function normalizeRegisteredToolResult(
  input: Record<string, unknown>,
): RegisteredToolCapabilityResult | undefined {
  if (
    !hasExactKeys(
      input,
      ["kind", "authority", "status", "result"],
      ["references"],
    ) ||
    input.authority !== "registered_plugin" ||
    input.status !== "executed"
  ) {
    return undefined;
  }
  const result = captureToolExecutionResult(input.result);
  const references = normalizeReferences(input.references);
  if (!result || references === null) return undefined;
  return Object.freeze({
    kind: "registered_tool_execution_result_v1" as const,
    authority: "registered_plugin" as const,
    status: "executed" as const,
    result,
    ...(references ? { references } : {}),
  });
}

function normalizeRuntimeRejection(
  input: Record<string, unknown>,
): RuntimeCapabilityRejectionResult | undefined {
  if (
    !hasExactKeys(
      input,
      ["kind", "authority", "status", "stage", "code", "message"],
      ["references"],
    ) ||
    input.authority !== "runtime" ||
    input.status !== "rejected" ||
    input.stage !== "before_external_execution" ||
    typeof input.code !== "string" ||
    input.code.trim().length === 0 ||
    typeof input.message !== "string" ||
    input.message.trim().length === 0
  ) {
    return undefined;
  }
  const references = normalizeReferences(input.references);
  if (references === null) return undefined;
  return Object.freeze({
    kind: "runtime_capability_rejection_v1" as const,
    authority: "runtime" as const,
    status: "rejected" as const,
    stage: "before_external_execution" as const,
    code: input.code,
    message: input.message,
    ...(references ? { references } : {}),
  });
}

function normalizeGenericResult(
  input: Record<string, unknown>,
): GenericCapabilityAdapterResult | undefined {
  if (
    !hasExactKeys(
      input,
      ["kind", "authority", "status", "ok", "payload"],
      ["references"],
    ) ||
    input.authority !== "capability_adapter" ||
    input.status !== "executed" ||
    typeof input.ok !== "boolean"
  ) {
    return undefined;
  }
  const payload = captureJsonValue(input.payload);
  const references = normalizeReferences(input.references);
  if (payload === undefined || references === null) return undefined;
  return Object.freeze({
    kind: "generic_capability_result_v1" as const,
    authority: "capability_adapter" as const,
    status: "executed" as const,
    ok: input.ok,
    payload,
    ...(references ? { references } : {}),
  });
}

function captureToolExecutionResult(
  input: unknown,
): CanonicalToolExecutionResult | undefined {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(
      input,
      ["ok", "tool", "output", "producedNewInformation"],
      [
        "progress",
        "actions",
        "exitCode",
        "stdout",
        "stderr",
        "data",
        "error",
        "errorCode",
      ],
    ) ||
    typeof input.ok !== "boolean" ||
    typeof input.tool !== "string" ||
    input.tool.trim().length === 0 ||
    typeof input.output !== "string" ||
    typeof input.producedNewInformation !== "boolean" ||
    (input.progress !== undefined && typeof input.progress !== "boolean") ||
    (input.exitCode !== undefined &&
      (typeof input.exitCode !== "number" ||
        !Number.isFinite(input.exitCode))) ||
    (input.stdout !== undefined && typeof input.stdout !== "string") ||
    (input.stderr !== undefined && typeof input.stderr !== "string") ||
    (input.error !== undefined && typeof input.error !== "string") ||
    (input.errorCode !== undefined && typeof input.errorCode !== "string") ||
    !validActions(input.actions) ||
    !validToolData(input.data)
  ) {
    return undefined;
  }
  const captured = captureJsonValue(input);
  return isPlainRecord(captured)
    ? (captured as unknown as CanonicalToolExecutionResult)
    : undefined;
}

function validActions(input: unknown): boolean {
  return (
    input === undefined ||
    (Array.isArray(input) &&
      input.every(
        (entry) =>
          isPlainRecord(entry) &&
          hasExactKeys(entry, ["type"], ["target", "details"]) &&
          typeof entry.type === "string" &&
          (entry.target === undefined || typeof entry.target === "string") &&
          (entry.details === undefined || typeof entry.details === "string"),
      ))
  );
}

function validToolData(input: unknown): boolean {
  if (input === undefined) return true;
  if (!isPlainRecord(input)) return false;
  const booleanFields = [
    "hasData",
    "mutationEvidence",
    "currentStateEvidence",
    "stateAlreadySatisfied",
  ];
  return !(
    booleanFields.some(
      (field) =>
        input[field] !== undefined && typeof input[field] !== "boolean",
    ) ||
    (input.itemCount !== undefined &&
      (typeof input.itemCount !== "number" ||
        !Number.isFinite(input.itemCount))) ||
    (input.mutationGrounding !== undefined &&
      typeof input.mutationGrounding !== "string") ||
    (input.observationMeta !== undefined &&
      !isPlainRecord(input.observationMeta)) ||
    (input.eventMeta !== undefined && !isPlainRecord(input.eventMeta)) ||
    captureJsonValue(input) === undefined
  );
}

function normalizeReferences(
  input: unknown,
): readonly CapabilityResultReference[] | undefined | null {
  if (input === undefined) return undefined;
  if (
    !Array.isArray(input) ||
    input.length > ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX
  ) {
    return null;
  }
  const targets = new Set<string>();
  const references: CapabilityResultReference[] = [];
  for (const candidate of input) {
    if (
      !isPlainRecord(candidate) ||
      !hasExactKeys(candidate, ["kind", "target"]) ||
      candidate.kind !== "tool_target" ||
      typeof candidate.target !== "string" ||
      candidate.target.trim().length === 0 ||
      candidate.target.length >
        ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH ||
      targets.has(candidate.target)
    ) {
      return null;
    }
    targets.add(candidate.target);
    references.push(
      Object.freeze({ kind: "tool_target" as const, target: candidate.target }),
    );
  }
  return Object.freeze(references);
}

function captureJsonValue(
  input: unknown,
  seen: WeakSet<object> = new WeakSet(),
): CapabilityJsonValue | undefined {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean"
  ) {
    return input;
  }
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : undefined;
  }
  if (typeof input !== "object" || seen.has(input)) return undefined;
  seen.add(input);
  try {
    if (Array.isArray(input)) {
      const values: CapabilityJsonValue[] = [];
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, index);
        if (!descriptor || !("value" in descriptor)) return undefined;
        const value = captureJsonValue(descriptor.value, seen);
        if (value === undefined) return undefined;
        values.push(value);
      }
      return Object.freeze(values);
    }
    if (!isPlainRecord(input) || !hasOnlyEnumerableDataProperties(input)) {
      return undefined;
    }
    const entries: Array<readonly [string, CapabilityJsonValue]> = [];
    for (const key of Object.keys(input)) {
      const value = captureJsonValue(input[key], seen);
      if (value === undefined) return undefined;
      entries.push([key, value] as const);
    }
    return Object.freeze(Object.fromEntries(entries)) as CapabilityJsonObject;
  } finally {
    seen.delete(input);
  }
}

function hasOnlyEnumerableDataProperties(input: Record<string, unknown>) {
  return Reflect.ownKeys(input).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(input);
  return (
    required.every((key) => Object.hasOwn(input, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function invalid(
  code: Extract<CapabilityAdapterResultNormalization, { ok: false }>["code"],
): CapabilityAdapterResultNormalization {
  return Object.freeze({ ok: false as const, code });
}

function acceptBoundedResult(
  value: CapabilityAdapterResult,
): CapabilityAdapterResultNormalization {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return invalid("result_not_json_safe");
  if (
    Buffer.byteLength(serialized, "utf8") >
    CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES
  ) {
    return invalid("result_too_large");
  }
  return Object.freeze({ ok: true as const, value });
}
