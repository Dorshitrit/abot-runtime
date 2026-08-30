import type { ToolPayloadChannelSpec } from "../tool-types.js";

export function isToolDefinitionRecordValue(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readToolDefinitionName(raw: unknown): string {
  if (!isToolDefinitionRecordValue(raw)) {
    throw new Error("Invalid tool definition entry (not an object)");
  }
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
    throw new Error("Invalid tool definition entry (name)");
  }
  return raw.name;
}

export function createInvalidToolDefinitionError(
  toolName: string,
  detail: string,
): Error {
  return new Error(`Invalid tool definition for ${toolName} (${detail})`);
}

export function isPayloadContextScope(
  value: unknown,
): value is "standard" | "target_only" | "target_with_artifacts" {
  if (value === "standard") return true;
  if (value === "target_only") return true;
  return value === "target_with_artifacts";
}

export function isPayloadTargetContext(
  value: unknown,
): value is "bounded" | "full" | "full_numbered" {
  if (value === "bounded") return true;
  if (value === "full") return true;
  return value === "full_numbered";
}

export function isPayloadResponseFormat(
  value: unknown,
): value is NonNullable<ToolPayloadChannelSpec["responseFormat"]> {
  if (value === "json") return true;
  return isToolDefinitionRecordValue(value);
}
