import { SESSION_MEMORY_SUMMARY_MAX_CHARACTERS } from "../../../../sessions/memory/contracts.js";

export type SessionMemoryCompactionParseResult =
  | Readonly<{ ok: true; summary: string }>
  | Readonly<{
      ok: false;
      issueCode:
        | "session_memory_output_not_json"
        | "session_memory_output_shape_invalid"
        | "session_memory_summary_invalid";
    }>;

export function parseSessionMemoryCompactionOutput(
  text: string,
): SessionMemoryCompactionParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.trim()) as unknown;
  } catch {
    return failure("session_memory_output_not_json");
  }
  if (!isSummaryEnvelope(decoded)) {
    return failure("session_memory_output_shape_invalid");
  }
  const summary = decoded.summary;
  const normalized = typeof summary === "string" ? summary.trim() : "";
  if (
    normalized.length === 0 ||
    normalized.length > SESSION_MEMORY_SUMMARY_MAX_CHARACTERS
  ) {
    return failure("session_memory_summary_invalid");
  }
  return Object.freeze({ ok: true as const, summary: normalized });
}

function isSummaryEnvelope(
  value: unknown,
): value is Readonly<{ summary: unknown }> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, "summary")
  );
}

function failure(
  issueCode: Extract<
    SessionMemoryCompactionParseResult,
    { ok: false }
  >["issueCode"],
): SessionMemoryCompactionParseResult {
  return Object.freeze({ ok: false as const, issueCode });
}
