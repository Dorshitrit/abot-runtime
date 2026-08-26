import { sanitizeJsonText } from "../../../src/plugin-sdk/index.js";

export type JsonShape =
  | string
  | Readonly<{ type: "primitive"; valueType: string }>
  | Readonly<{
      type: "array";
      length: number;
      sampledItems: readonly JsonShape[];
      returnedItems: number;
      truncated: boolean;
    }>
  | Readonly<{
      type: "object";
      totalKeys: number;
      returnedKeys: number;
      truncated: boolean;
      keys: readonly Readonly<{ key: string; value: JsonShape }>[];
    }>;

export type JsonShapeSummary = Readonly<{
  shape: JsonShape;
  metadata: Readonly<{
    maxDepth: number;
    maxNodes: number;
    visitedNodes: number;
    truncatedNodes: number;
    truncatedKeys: number;
    arraySampleSize: number;
    objectKeyLimit: number;
    objectKeyMaxChars: number;
  }>;
}>;

const OBJECT_KEY_LIMIT = 40;
const OBJECT_KEY_MAX_CHARS = 64;
const ARRAY_SAMPLE_SIZE = 3;
const MAX_NODES = 200;

function boundedKey(value: string): string {
  const safeValue = sanitizeJsonText(value);
  if (safeValue.length <= OBJECT_KEY_MAX_CHARS) return safeValue;
  const marker = "...[truncated]";
  return `${safeValue.slice(0, OBJECT_KEY_MAX_CHARS - marker.length)}${marker}`;
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function summarizeJsonShape(
  value: unknown,
  maxDepth: number,
): JsonShapeSummary {
  let visitedNodes = 0;
  let truncatedNodes = 0;
  let truncatedKeys = 0;

  const visit = (current: unknown, depth: number): JsonShape => {
    if (visitedNodes >= MAX_NODES) {
      truncatedNodes += 1;
      return `[${valueType(current)} omitted: node budget reached]`;
    }
    visitedNodes += 1;
    if (depth >= maxDepth) {
      if (current !== null && typeof current === "object") truncatedNodes += 1;
      return `[${valueType(current)} at depth limit]`;
    }
    if (Array.isArray(current)) {
      const sampled = current.slice(0, ARRAY_SAMPLE_SIZE);
      if (sampled.length < current.length) truncatedNodes += 1;
      return Object.freeze({
        type: "array" as const,
        length: current.length,
        sampledItems: Object.freeze(
          sampled.map((item) => visit(item, depth + 1)),
        ),
        returnedItems: sampled.length,
        truncated: sampled.length < current.length,
      });
    }
    if (current && typeof current === "object") {
      const record = current as Record<string, unknown>;
      const names = Object.keys(record).sort((left, right) =>
        left.localeCompare(right),
      );
      const returnedNames = names.slice(0, OBJECT_KEY_LIMIT);
      if (returnedNames.length < names.length) truncatedNodes += 1;
      return Object.freeze({
        type: "object" as const,
        totalKeys: names.length,
        returnedKeys: returnedNames.length,
        truncated: returnedNames.length < names.length,
        keys: Object.freeze(
          returnedNames.map((key) => {
            if (key.length > OBJECT_KEY_MAX_CHARS) truncatedKeys += 1;
            return Object.freeze({
              key: boundedKey(key),
              value: visit(record[key], depth + 1),
            });
          }),
        ),
      });
    }
    return Object.freeze({
      type: "primitive" as const,
      valueType: valueType(current),
    });
  };

  return Object.freeze({
    shape: visit(value, 0),
    metadata: Object.freeze({
      maxDepth,
      maxNodes: MAX_NODES,
      visitedNodes,
      truncatedNodes,
      truncatedKeys,
      arraySampleSize: ARRAY_SAMPLE_SIZE,
      objectKeyLimit: OBJECT_KEY_LIMIT,
      objectKeyMaxChars: OBJECT_KEY_MAX_CHARS,
    }),
  });
}

export function parseJsonErrorPosition(
  error: unknown,
  source: string,
): Readonly<{ position: number; line: number; column: number }> | undefined {
  const message = error instanceof Error ? error.message : "";
  const match = /position\s+(\d+)/iu.exec(message);
  if (!match?.[1]) return undefined;
  const position = Number(match[1]);
  if (!Number.isSafeInteger(position) || position < 0) return undefined;
  const prefix = source.slice(0, position);
  const lineStart = prefix.lastIndexOf("\n");
  return Object.freeze({
    position,
    line: prefix.split("\n").length,
    column: position - lineStart,
  });
}
