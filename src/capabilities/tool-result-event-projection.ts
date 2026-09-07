import type {
  ToolEventMetadata,
  ToolEventPresentation,
  ToolEventResultMetadataProjection,
  ToolExecutionResult,
} from "./tool-types.js";

const PREVIEW_CHARACTER_LIMIT = 1_200;
const PREVIEW_LINE_LIMIT = 20;
const EVENT_PREVIEW_CHARACTER_LIMIT = 2_400;

/** Derive display metadata without changing canonical tool evidence. */
export function projectToolResultEventMetadata(
  result: ToolExecutionResult,
  projections: ToolEventPresentation["resultMetadata"],
): ToolEventMetadata | undefined {
  if (!projections) return undefined;
  const metadata: ToolEventMetadata = {};
  let remainingCharacters = EVENT_PREVIEW_CHARACTER_LIMIT;
  for (const [key, projection] of Object.entries(projections)) {
    const value = readProjectedResultValue(result, projection);
    if (value === undefined) continue;
    if (typeof value !== "string") {
      metadata[key] = value;
      continue;
    }
    const preview = boundResultPreview(value, remainingCharacters);
    metadata[key] = preview.text;
    metadata[`${key}Truncated`] = preview.truncated;
    remainingCharacters -= preview.text.length;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function readProjectedResultValue(
  result: ToolExecutionResult,
  projection: ToolEventResultMetadataProjection,
): string | number | boolean | undefined {
  const value = readOwnResultPath(result, projection.path);
  if (projection.kind === "number") {
    return isFiniteResultNumber(value) ? value : undefined;
  }
  if (projection.kind === "boolean") {
    return typeof value === "boolean" ? value : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function readOwnResultPath(result: ToolExecutionResult, path: string): unknown {
  let value: unknown = result;
  for (const segment of path.split(".")) {
    if (!isOwnResultContainer(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function isOwnResultContainer(
  value: unknown,
  key: string,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  return Object.hasOwn(value, key);
}

function isFiniteResultNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function boundResultPreview(value: string, remainingCharacters: number) {
  const characterLimit = Math.min(PREVIEW_CHARACTER_LIMIT, remainingCharacters);
  let end = Math.min(value.length, characterLimit);
  let lineCount = 1;
  for (let index = 0; index < end; index += 1) {
    if (!startsPreviewLine(value, index)) continue;
    lineCount += 1;
    if (lineCount <= PREVIEW_LINE_LIMIT) continue;
    end = index;
    break;
  }
  if (splitsSurrogatePair(value, end)) end -= 1;
  return { text: value.slice(0, end), truncated: end < value.length };
}

function startsPreviewLine(value: string, index: number): boolean {
  if (value[index] === "\r") return true;
  return value[index] === "\n" && value[index - 1] !== "\r";
}

function splitsSurrogatePair(value: string, end: number): boolean {
  if (end <= 0 || end >= value.length) return false;
  const before = value.charCodeAt(end - 1);
  const after = value.charCodeAt(end);
  return (
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  );
}
