import type { DegradedFinalizationPhrasing } from "./contract.js";

export function parseDegradedFinalizationPhrasing(
  text: string,
): DegradedFinalizationPhrasing | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim()) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["failureNotice", "nextStep"])
  ) {
    return null;
  }

  const failureNotice = parseRequiredText(parsed.failureNotice);
  const nextStep = parseRequiredText(parsed.nextStep);
  return failureNotice && nextStep ? { failureNotice, nextStep } : null;
}

function parseRequiredText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  record: Record<string, unknown>,
  expectedKeys: string[],
): boolean {
  const expected = new Set(expectedKeys);
  const actual = Object.keys(record);
  return (
    actual.length === expected.size && actual.every((key) => expected.has(key))
  );
}
