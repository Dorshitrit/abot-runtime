import { createHash } from "node:crypto";

const ERROR_NAME_MAX_LENGTH = 128;
const ERROR_MESSAGE_MAX_LENGTH = 4_096;
const ERROR_FIELD_MAX_LENGTH = 512;
const STABLE_ERROR_FIELD_IDS = Object.freeze([
  "stage",
  "code",
  "errorCode",
  "issueCode",
  "status",
  "exitCode",
] as const);

type StableErrorField = readonly [string, string | number];
type StableErrorFieldsResult =
  | Readonly<{ ok: true; value: readonly StableErrorField[] }>
  | Readonly<{ ok: false }>;

/** Returns only an opaque digest; raw thrown values never cross this boundary. */
export function createStableWorkerCapabilityErrorFingerprint(input: {
  domain: "prepare" | "execute";
  error: unknown;
}): string | undefined {
  try {
    const identity = stableErrorIdentity(input.error);
    if (identity === undefined) return undefined;
    const canonical = JSON.stringify([
      "worker_capability_error_v1",
      input.domain,
      identity,
    ]);
    return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  } catch {
    return undefined;
  }
}

function stableErrorIdentity(error: unknown): unknown | undefined {
  if (error instanceof Error) {
    const name = canonicalErrorName(error.name);
    if (name === undefined) return undefined;
    const fields = stableErrorFields(error);
    if (!fields.ok) return undefined;
    if (fields.value.length > 0) {
      return Object.freeze(["error_fields_v1", name, fields.value]);
    }
    if (error.cause !== undefined) return undefined;
    const message = canonicalErrorMessage(error.message);
    return message === undefined
      ? undefined
      : Object.freeze(["error_message_v1", name, message]);
  }

  if (!isPlainRecord(error)) return undefined;
  const fields = stableErrorFields(error);
  if (!fields.ok) return undefined;
  const name = optionalCanonicalErrorName(error.name);
  if (!name.ok) return undefined;
  if (fields.value.length > 0) {
    return Object.freeze(["thrown_fields_v1", name.value, fields.value]);
  }
  if (Object.keys(error).some((key) => key !== "name" && key !== "message")) {
    return undefined;
  }
  const message = canonicalErrorMessage(error.message);
  return name.value === null || message === undefined
    ? undefined
    : Object.freeze(["thrown_message_v1", name.value, message]);
}

function stableErrorFields(
  error: Error | Readonly<Record<string, unknown>>,
): StableErrorFieldsResult {
  const record = error as unknown as Readonly<Record<string, unknown>>;
  const fields: StableErrorField[] = [];
  for (const key of STABLE_ERROR_FIELD_IDS) {
    const value = record[key];
    if (value === undefined || value === null || value === "") continue;
    if (
      typeof value === "string" &&
      value.length <= ERROR_FIELD_MAX_LENGTH &&
      value === value.trim()
    ) {
      fields.push(Object.freeze([key, value] as const));
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      fields.push(Object.freeze([key, value] as const));
      continue;
    }
    return Object.freeze({ ok: false as const });
  }
  return Object.freeze({ ok: true as const, value: Object.freeze(fields) });
}

function optionalCanonicalErrorName(
  value: unknown,
): Readonly<{ ok: true; value: string | null }> | Readonly<{ ok: false }> {
  if (value === undefined || value === null) {
    return Object.freeze({ ok: true as const, value: null });
  }
  const name = canonicalErrorName(value);
  return name === undefined
    ? Object.freeze({ ok: false as const })
    : Object.freeze({ ok: true as const, value: name });
}

function canonicalErrorName(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= ERROR_NAME_MAX_LENGTH &&
    /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value)
    ? value
    : undefined;
}

function canonicalErrorMessage(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= ERROR_MESSAGE_MAX_LENGTH &&
    value === value.trim()
    ? value
    : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
