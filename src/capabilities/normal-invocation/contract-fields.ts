import { TOOL_NORMAL_INVOCATION_IDENTIFIER_MAX_LENGTH } from "./contracts.js";

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys(
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

export function fail(toolName: string, path: string, issue: string): never {
  throw new Error(
    `Invalid normal invocation contract for ${toolName} (${path}: ${issue})`,
  );
}

export function boundedText(
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

export function identifier(
  toolName: string,
  path: string,
  value: unknown,
): string {
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

export function boundedInteger(
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

export function finiteNumber(
  toolName: string,
  path: string,
  value: unknown,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(toolName, path, "expected a finite number");
  }
  return value;
}
