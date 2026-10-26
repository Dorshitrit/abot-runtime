const MAX_JSON_OUTPUT_BYTES = 256 * 1024;
const MAX_JSON_PATH_SEGMENTS = 4;
const MAX_JSON_ARRAY_INDEX = 255;
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isJsonArrayIndex(segment: string): boolean {
  if (!/^(0|[1-9][0-9]*)$/u.test(segment)) return false;
  return Number(segment) <= MAX_JSON_ARRAY_INDEX;
}

function isJsonObjectKey(segment: string): boolean {
  if (FORBIDDEN_JSON_KEYS.has(segment)) return false;
  return /^[a-zA-Z][a-zA-Z0-9_]*$/u.test(segment);
}

/** Shared declaration/runtime boundary; selectors never evaluate expressions. */
export function isToolResultJsonPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const segments = value.split(".");
  if (!segments.length || segments.length > MAX_JSON_PATH_SEGMENTS) return false;
  return segments.every(segment => isJsonObjectKey(segment) || isJsonArrayIndex(segment));
}

function parseBoundedJsonOutput(output: string): unknown {
  if (output.length > MAX_JSON_OUTPUT_BYTES) return undefined;
  if (Buffer.byteLength(output, "utf8") > MAX_JSON_OUTPUT_BYTES) return undefined;
  try { return JSON.parse(output); }
  catch { return undefined; }
}

function readOwnJsonValue(root: unknown, path: string): unknown {
  let value = root;
  for (const segment of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    if (Array.isArray(value) && !isJsonArrayIndex(segment)) return undefined;
    if (!Array.isArray(value) && !isJsonObjectKey(segment)) return undefined;
    if (!Object.hasOwn(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/** A projector invocation parses at most once and never changes execution evidence. */
export function createToolResultJsonReader(output: string): (path: string) => unknown {
  let parsed = false;
  let root: unknown;
  return path => {
    if (!isToolResultJsonPath(path)) return undefined;
    if (!parsed) {
      root = parseBoundedJsonOutput(output);
      parsed = true;
    }
    return readOwnJsonValue(root, path);
  };
}
