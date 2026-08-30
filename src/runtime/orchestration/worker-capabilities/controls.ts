import {
  WORKER_CAPABILITY_CONTROL_ARRAY_MAX_ITEMS,
  WORKER_CAPABILITY_CONTROL_COUNT_MAX,
  WORKER_CAPABILITY_CONTROL_ENUM_MAX_VALUES,
  WORKER_CAPABILITY_CONTROL_ENUM_VALUE_MAX_LENGTH,
  WORKER_CAPABILITY_CONTROL_ID_MAX_LENGTH,
  WORKER_CAPABILITY_CONTROL_STRING_MAX_LENGTH,
  type WorkerCapabilityArrayControl,
  type WorkerCapabilityControl,
  type WorkerCapabilityControls,
  type WorkerCapabilityControlsSchema,
  type WorkerCapabilityScalarControl,
} from "./contracts.js";

export type WorkerCapabilityControlsSchemaNormalization =
  | Readonly<{ ok: true; value: WorkerCapabilityControlsSchema }>
  | Readonly<{ ok: false; issueCode: string }>;

export type WorkerCapabilityControlsValidation =
  | Readonly<{ ok: true; value: WorkerCapabilityControls }>
  | Readonly<{
      ok: false;
      issueCode: string;
      controlId?: string;
    }>;

export function normalizeWorkerCapabilityControlsSchema(
  input: unknown,
): WorkerCapabilityControlsSchemaNormalization {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      "type",
      "additionalProperties",
      "properties",
      "required",
    ]) ||
    input.type !== "object" ||
    input.additionalProperties !== false ||
    !isPlainRecord(input.properties) ||
    !Array.isArray(input.required)
  ) {
    return failure("controls_schema_invalid");
  }
  const entries = Object.entries(input.properties);
  if (entries.length > WORKER_CAPABILITY_CONTROL_COUNT_MAX) {
    return failure("controls_schema_count_invalid");
  }
  const properties: Record<string, WorkerCapabilityControl> = {};
  for (const [controlId, rawControl] of entries) {
    if (!isControlId(controlId)) {
      return failure("controls_schema_id_invalid");
    }
    const normalized = normalizeControl(rawControl);
    if (!normalized.ok) return normalized;
    properties[controlId] = normalized.value;
  }
  if (
    input.required.some(
      (controlId) =>
        typeof controlId !== "string" || !Object.hasOwn(properties, controlId),
    ) ||
    new Set(input.required).size !== input.required.length
  ) {
    return failure("controls_schema_required_invalid");
  }
  return {
    ok: true,
    value: Object.freeze({
      type: "object" as const,
      additionalProperties: false as const,
      properties: Object.freeze(properties),
      required: Object.freeze([...input.required] as string[]),
    }),
  };
}

export function validateWorkerCapabilityControls(
  schema: WorkerCapabilityControlsSchema,
  input: unknown,
): WorkerCapabilityControlsValidation {
  if (!isPlainRecord(input)) {
    return failure("controls_not_object");
  }
  const suppliedIds = Object.keys(input);
  const unknownId = suppliedIds.find(
    (controlId) => !Object.hasOwn(schema.properties, controlId),
  );
  if (unknownId) {
    return failure("controls_unknown", unknownId);
  }
  const missingId = schema.required.find(
    (controlId) => !Object.hasOwn(input, controlId),
  );
  if (missingId) {
    return failure("controls_required_missing", missingId);
  }

  const controls: Record<string, unknown> = {};
  for (const controlId of suppliedIds) {
    const control = schema.properties[controlId]!;
    const value = normalizeControlValue(control, input[controlId]);
    if (!value.ok) {
      return failure(value.issueCode, controlId);
    }
    controls[controlId] = value.value;
  }
  return { ok: true, value: Object.freeze(controls) };
}

/**
 * Captures the complete non-payload action already accepted by a preparing
 * adapter. These controls may include staged values that are deliberately
 * absent from the model-facing descriptor, so only the shared flat controls
 * envelope is enforced here.
 */
export function validateWorkerCapabilityAcceptedControls(
  input: unknown,
): WorkerCapabilityControlsValidation {
  if (!isPlainRecord(input)) {
    return failure("accepted_controls_not_object");
  }
  const entries = Object.entries(input);
  if (entries.length > WORKER_CAPABILITY_CONTROL_COUNT_MAX) {
    return failure("accepted_controls_count_invalid");
  }

  const controls: Record<string, unknown> = {};
  for (const [controlId, inputValue] of entries) {
    if (!isControlId(controlId)) {
      return failure("accepted_controls_id_invalid", controlId);
    }
    const value = normalizeAcceptedControlValue(inputValue);
    if (!value.ok) {
      return failure(value.issueCode, controlId);
    }
    controls[controlId] = value.value;
  }
  return { ok: true, value: Object.freeze(controls) };
}

function normalizeControl(
  input: unknown,
):
  | Readonly<{ ok: true; value: WorkerCapabilityControl }>
  | Readonly<{ ok: false; issueCode: string }> {
  if (!isPlainRecord(input) || typeof input.type !== "string") {
    return failure("controls_schema_property_invalid");
  }
  if (input.type === "array") {
    if (
      !hasExactKeys(input, ["type", "items", "minItems", "maxItems"]) ||
      !isBoundedInteger(
        input.minItems,
        0,
        WORKER_CAPABILITY_CONTROL_ARRAY_MAX_ITEMS,
      ) ||
      !isBoundedInteger(
        input.maxItems,
        1,
        WORKER_CAPABILITY_CONTROL_ARRAY_MAX_ITEMS,
      ) ||
      input.minItems > input.maxItems
    ) {
      return failure("controls_schema_array_invalid");
    }
    const items = normalizeScalarControl(input.items);
    if (!items.ok) return items;
    return {
      ok: true,
      value: Object.freeze({
        type: "array" as const,
        items: items.value,
        minItems: input.minItems,
        maxItems: input.maxItems,
      }),
    };
  }
  return normalizeScalarControl(input);
}

function normalizeScalarControl(
  input: unknown,
):
  | Readonly<{ ok: true; value: WorkerCapabilityScalarControl }>
  | Readonly<{ ok: false; issueCode: string }> {
  if (!isPlainRecord(input)) {
    return failure("controls_schema_scalar_invalid");
  }
  if (input.type === "string" && Object.hasOwn(input, "enum")) {
    if (
      !hasExactKeys(input, ["type", "enum"]) ||
      !Array.isArray(input.enum) ||
      input.enum.length === 0 ||
      input.enum.length > WORKER_CAPABILITY_CONTROL_ENUM_MAX_VALUES ||
      input.enum.some(
        (value) =>
          typeof value !== "string" ||
          value.length > WORKER_CAPABILITY_CONTROL_ENUM_VALUE_MAX_LENGTH,
      ) ||
      new Set(input.enum).size !== input.enum.length
    ) {
      return failure("controls_schema_enum_invalid");
    }
    return {
      ok: true,
      value: Object.freeze({
        type: "string" as const,
        enum: Object.freeze([...input.enum] as string[]),
      }),
    };
  }
  if (input.type === "string") {
    if (hasExactKeys(input, ["type", "minLength"])) {
      if (
        !isBoundedInteger(
          input.minLength,
          0,
          WORKER_CAPABILITY_CONTROL_STRING_MAX_LENGTH,
        )
      ) {
        return failure("controls_schema_string_invalid");
      }
      return {
        ok: true,
        value: Object.freeze({
          type: "string" as const,
          minLength: input.minLength,
        }),
      };
    }
    if (
      !hasExactKeys(input, ["type", "minLength", "maxLength"]) ||
      !isBoundedInteger(
        input.minLength,
        0,
        WORKER_CAPABILITY_CONTROL_STRING_MAX_LENGTH,
      ) ||
      !isBoundedInteger(
        input.maxLength,
        1,
        WORKER_CAPABILITY_CONTROL_STRING_MAX_LENGTH,
      ) ||
      input.minLength > input.maxLength
    ) {
      return failure("controls_schema_string_invalid");
    }
    return {
      ok: true,
      value: Object.freeze({
        type: "string" as const,
        minLength: input.minLength,
        maxLength: input.maxLength,
      }),
    };
  }
  if (input.type === "number" || input.type === "integer") {
    if (
      !hasExactKeys(input, ["type", "minimum", "maximum"]) ||
      typeof input.minimum !== "number" ||
      !Number.isFinite(input.minimum) ||
      typeof input.maximum !== "number" ||
      !Number.isFinite(input.maximum) ||
      input.minimum > input.maximum ||
      (input.type === "integer" &&
        (!Number.isSafeInteger(input.minimum) ||
          !Number.isSafeInteger(input.maximum)))
    ) {
      return failure("controls_schema_number_invalid");
    }
    return {
      ok: true,
      value: Object.freeze({
        type: input.type,
        minimum: input.minimum,
        maximum: input.maximum,
      }),
    };
  }
  if (input.type === "boolean") {
    return hasExactKeys(input, ["type"])
      ? {
          ok: true,
          value: Object.freeze({ type: "boolean" as const }),
        }
      : failure("controls_schema_boolean_invalid");
  }
  return failure("controls_schema_scalar_invalid");
}

function normalizeControlValue(
  control: WorkerCapabilityControl,
  input: unknown,
):
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; issueCode: string }> {
  if (control.type === "array") {
    if (
      !Array.isArray(input) ||
      input.length < control.minItems ||
      input.length > control.maxItems
    ) {
      return failure("controls_array_invalid");
    }
    const values: unknown[] = [];
    for (const item of input) {
      const value = normalizeScalarValue(control.items, item);
      if (!value.ok) return value;
      values.push(value.value);
    }
    return { ok: true, value: Object.freeze(values) };
  }
  return normalizeScalarValue(control, input);
}

function normalizeAcceptedControlValue(
  input: unknown,
):
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; issueCode: string }> {
  if (!Array.isArray(input)) return normalizeAcceptedScalarValue(input);
  if (input.length > WORKER_CAPABILITY_CONTROL_ARRAY_MAX_ITEMS) {
    return failure("accepted_controls_array_invalid");
  }
  const values: unknown[] = [];
  for (const item of input) {
    const value = normalizeAcceptedScalarValue(item);
    if (!value.ok) return value;
    values.push(value.value);
  }
  return { ok: true, value: Object.freeze(values) };
}

function normalizeAcceptedScalarValue(
  input: unknown,
):
  | Readonly<{ ok: true; value: string | number | boolean }>
  | Readonly<{ ok: false; issueCode: string }> {
  if (
    typeof input === "string" ||
    typeof input === "boolean" ||
    (typeof input === "number" && Number.isFinite(input))
  ) {
    return { ok: true, value: input };
  }
  return failure("accepted_controls_value_invalid");
}

function normalizeScalarValue(
  control: WorkerCapabilityScalarControl,
  input: unknown,
):
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; issueCode: string }> {
  if (control.type === "string") {
    if (typeof input !== "string") {
      return failure("controls_string_invalid");
    }
    if ("enum" in control) {
      return control.enum.includes(input)
        ? { ok: true, value: input }
        : failure("controls_enum_invalid");
    }
    return input.length >= control.minLength &&
      (!("maxLength" in control) || input.length <= control.maxLength)
      ? { ok: true, value: input }
      : failure("controls_string_invalid");
  }
  if (control.type === "boolean") {
    return typeof input === "boolean"
      ? { ok: true, value: input }
      : failure("controls_boolean_invalid");
  }
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input < control.minimum ||
    input > control.maximum ||
    (control.type === "integer" && !Number.isSafeInteger(input))
  ) {
    return failure("controls_number_invalid");
  }
  return { ok: true, value: input };
}

function isControlId(input: string): boolean {
  return (
    input.length > 0 &&
    input.length <= WORKER_CAPABILITY_CONTROL_ID_MAX_LENGTH &&
    /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u.test(input)
  );
}

function isBoundedInteger(
  input: unknown,
  minimum: number,
  maximum: number,
): input is number {
  return (
    typeof input === "number" &&
    Number.isSafeInteger(input) &&
    input >= minimum &&
    input <= maximum
  );
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  const actual = Object.keys(input);
  return (
    actual.length === allowed.size && actual.every((key) => allowed.has(key))
  );
}

function failure(
  issueCode: string,
  controlId?: string,
): Readonly<{ ok: false; issueCode: string; controlId?: string }> {
  return Object.freeze({
    ok: false as const,
    issueCode,
    ...(controlId ? { controlId } : {}),
  });
}
