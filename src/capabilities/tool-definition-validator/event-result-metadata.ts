import type { ToolEventPresentation } from "../tool-types.js";
import { isToolDefinitionRecordValue } from "./definition-shape.js";

const RESULT_METADATA_LIMIT = 16;
const RESULT_PATH_SEGMENT_LIMIT = 4;
const RESULT_PROJECTION_KINDS = ["preview", "number", "boolean"] as const;
const FORBIDDEN_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

export function parseEventResultMetadata(
  raw: unknown,
  path: string,
): ToolEventPresentation["resultMetadata"] {
  if (raw === undefined) return undefined;
  if (!isToolDefinitionRecordValue(raw)) {
    throw new Error(`${path} must be an object`);
  }
  const entries = Object.entries(raw);
  if (entries.length > RESULT_METADATA_LIMIT) {
    throw new Error(`${path} exceeds ${RESULT_METADATA_LIMIT} projections`);
  }
  const result = Object.fromEntries(
    entries.map(([key, value]) => {
      if (!hasSupportedResultMetadataKey(key)) {
        throw new Error(`${path} contains an invalid metadata key`);
      }
      if (!isToolDefinitionRecordValue(value)) {
        throw new Error(`${path}.${key} must be an object`);
      }
      if (hasUnknownResultProjectionFields(value)) {
        throw new Error(`${path}.${key} contains an unknown field`);
      }
      if (!hasSupportedResultMetadataPath(value.path)) {
        throw new Error(`${path}.${key}.path must select output or data`);
      }
      if (!isResultProjectionKind(value.kind)) {
        throw new Error(`${path}.${key}.kind is not supported`);
      }
      return [key, { path: value.path, kind: value.kind }];
    }),
  );
  for (const [key, projection] of Object.entries(result)) {
    if (projection.kind !== "preview") continue;
    if (Object.hasOwn(result, `${key}Truncated`)) {
      throw new Error(`${path}.${key} conflicts with its truncation metadata`);
    }
  }
  return result;
}

function hasSupportedResultMetadataKey(key: string): boolean {
  if (!/^[a-zA-Z][a-zA-Z0-9]{0,63}$/u.test(key)) return false;
  return !FORBIDDEN_PATH_SEGMENTS.has(key);
}

function hasSupportedResultMetadataPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "output") return true;
  const segments = value.split(".");
  if (segments[0] !== "data") return false;
  if (segments.length < 2 || segments.length > RESULT_PATH_SEGMENT_LIMIT)
    return false;
  return segments.every(isSupportedResultPathSegment);
}

function hasUnknownResultProjectionFields(
  value: Record<string, unknown>,
): boolean {
  return Object.keys(value).some(
    (field) => field !== "path" && field !== "kind",
  );
}

function isSupportedResultPathSegment(segment: string): boolean {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(segment)) return false;
  return !FORBIDDEN_PATH_SEGMENTS.has(segment);
}

function isResultProjectionKind(
  value: unknown,
): value is (typeof RESULT_PROJECTION_KINDS)[number] {
  return RESULT_PROJECTION_KINDS.includes(
    value as (typeof RESULT_PROJECTION_KINDS)[number],
  );
}
