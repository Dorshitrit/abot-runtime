export type EvidenceValuePath = readonly (string | number)[];

/** Match complete values only; field names and substrings carry no identity. */
export function findExactEvidencePath(
  source: unknown,
  expected: string | readonly unknown[],
): EvidenceValuePath | undefined {
  const expectedArray = Array.isArray(expected)
    ? JSON.stringify(expected)
    : undefined;
  function visit(
    value: unknown,
    path: EvidenceValuePath,
  ): EvidenceValuePath | undefined {
    if (isExactEvidenceValue(value, expected, expectedArray))
      return Object.freeze([...path]);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const found = visit(value[index], [...path, index]);
        if (found) return found;
      }
      return undefined;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const found = visit(child, [...path, key]);
        if (found) return found;
      }
    }
    return undefined;
  }
  return visit(source, []);
}

function isExactEvidenceValue(
  value: unknown,
  expected: string | readonly unknown[],
  expectedArray: string | undefined,
): boolean {
  if (typeof expected === "string") return value === expected;
  if (!Array.isArray(value) || expectedArray === undefined) return false;
  return JSON.stringify(value) === expectedArray;
}
