import type { ToolEventMetadataProjection } from "./tool-types.js";

/** Opt-in exact text stays display-only and never replaces the accepted input. */
export function projectDeclaredInputText(
  raw: unknown,
  projection: ToolEventMetadataProjection,
): Readonly<{ text: string; truncated: boolean }> | undefined {
  if (typeof raw !== "string") return undefined;
  const text = projection.preserveWhitespace === true ? raw : raw.trim();
  if (text.length === 0) return undefined;
  const limit = Math.min(4_096, projection.maxLength ?? 500);
  let end = Math.min(text.length, limit);
  if (splitsInputTextSurrogatePair(text, end)) end -= 1;
  return { text: text.slice(0, end), truncated: end < text.length };
}

export function hasDeclaredInputTextOptions(
  projection: ToolEventMetadataProjection,
): boolean {
  if (projection.kind !== "string" && projection.kind !== "string_array")
    return false;
  if (projection.maxLength !== undefined) return true;
  return projection.preserveWhitespace !== undefined;
}

function splitsInputTextSurrogatePair(text: string, end: number): boolean {
  if (end <= 0 || end >= text.length) return false;
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  if (before < 0xd800 || before > 0xdbff) return false;
  return after >= 0xdc00 && after <= 0xdfff;
}

/** Preserve array positions, empty values and whitespace in opt-in arguments. */
export function projectDeclaredInputFields(
  key: string,
  raw: unknown,
  projection: ToolEventMetadataProjection,
): [string, unknown][] {
  if (projection.kind === "string_array") {
    return projectDeclaredInputArray(key, raw, projection);
  }
  const text = projectDeclaredInputText(raw, projection);
  return text
    ? [
        [key, text.text],
        [`${key}Truncated`, text.truncated],
      ]
    : [];
}

function projectDeclaredInputArray(
  key: string,
  raw: unknown,
  projection: ToolEventMetadataProjection,
): [string, unknown][] {
  if (!hasOnlyStringArguments(raw)) return [];
  const omittedCount = Math.max(0, raw.length - 32);
  let truncated = omittedCount > 0;
  const values = raw.slice(0, 32).map((argument) => {
    const text = projectDeclaredInputText(argument, projection);
    if (text?.truncated) truncated = true;
    return text?.text ?? "";
  });
  return [
    [key, values],
    [`${key}Truncated`, truncated],
    [`${key}OmittedCount`, omittedCount],
  ];
}

function hasOnlyStringArguments(raw: unknown): raw is string[] {
  if (!Array.isArray(raw)) return false;
  return raw.every((value) => typeof value === "string");
}
