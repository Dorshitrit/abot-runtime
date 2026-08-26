export function nonEmpty(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0
    ? input.trim()
    : undefined;
}

export function safeIssueCode(input: unknown): string | undefined {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 128 ||
    !/^[a-z][a-z0-9._:-]*$/u.test(input)
  ) {
    return undefined;
  }
  return input;
}

export function isPlainRecord(
  input: unknown,
): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}
