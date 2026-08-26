function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeJson(value: unknown, location: string): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${location} must not contain non-finite numbers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeJson(entry, `${location}[${index}]`),
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`${location} must contain only JSON values`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${location} must contain only plain JSON objects`);
  }
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort(compareText)
      .map((key) => [key, normalizeJson(source[key], `${location}.${key}`)]),
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeJson(value, "value"), null, 2);
}
