import { createHash } from "node:crypto";

import type { ResolvedRuntimeToolPath } from "../../../src/plugin-sdk/index.js";
import { ProjectInspectionError } from "./inspection-failure.js";
import type { ProjectTreeListing } from "./tree.js";

const CURSOR_PREFIX = "po1.";
const CURSOR_MAX_CHARS = 512;
const HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type CursorPayload = Readonly<{ v: 1; q: string; l: string; o: number }>;
type CheckedCursorPayload = CursorPayload & Readonly<{ c: string }>;
export type ProjectPageCursorBinding = Readonly<{
  query: string;
  listing: string;
  entryCount: number;
}>;

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

export function bindProjectPageCursor(
  target: ResolvedRuntimeToolPath,
  depth: number,
  listing: ProjectTreeListing,
): ProjectPageCursorBinding {
  return Object.freeze({
    query: fingerprint([target.rootPath, target.absolutePath, target.logicalPath, target.location, depth]),
    listing: fingerprint(listing.entries),
    entryCount: listing.entries.length,
  });
}

export function encodeProjectPageCursor(
  binding: ProjectPageCursorBinding,
  offset: number,
): string {
  const payload: CursorPayload = { v: 1, q: binding.query, l: binding.listing, o: offset };
  const checked = { ...payload, c: fingerprint(payload) };
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(checked), "utf8").toString("base64url");
}

function invalidCursor(): never {
  throw new ProjectInspectionError(
    "project_cursor_invalid",
    "The project continuation cursor is invalid. Start a fresh inspection without a cursor.",
  );
}

function isCursorRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasSupportedCursorFormat(cursor: string): boolean {
  if (!cursor.startsWith(CURSOR_PREFIX)) return false;
  return cursor.length <= CURSOR_MAX_CHARS;
}

function isCursorFingerprint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return HASH_PATTERN.test(value);
}

function isContinuationOffset(value: unknown): value is number {
  if (typeof value !== "number") return false;
  if (!Number.isSafeInteger(value)) return false;
  return value > 0;
}

function hasValidCursorFields(value: unknown): value is CheckedCursorPayload {
  if (!isCursorRecord(value)) return false;
  const hasExactFields = Object.keys(value).sort().join(",") === "c,l,o,q,v";
  if (!hasExactFields) return false;
  if (value.v !== 1) return false;
  if (!isCursorFingerprint(value.q)) return false;
  if (!isCursorFingerprint(value.l)) return false;
  if (typeof value.c !== "string") return false;
  return isContinuationOffset(value.o);
}

function decodeCursor(cursor: string): CursorPayload {
  if (!hasSupportedCursorFormat(cursor)) invalidCursor();
  const encoded = cursor.slice(CURSOR_PREFIX.length);
  let parsed: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) invalidCursor();
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalidCursor();
  }
  if (!hasValidCursorFields(parsed)) invalidCursor();
  const payload: CursorPayload = { v: 1, q: parsed.q, l: parsed.l, o: parsed.o };
  const hasMatchingChecksum = parsed.c === fingerprint(payload);
  if (!hasMatchingChecksum) invalidCursor();
  const canonical = CURSOR_PREFIX + Buffer.from(
    JSON.stringify({ ...payload, c: parsed.c }), "utf8",
  ).toString("base64url");
  if (canonical !== cursor) invalidCursor();
  return payload;
}

export function resolveProjectPageOffset(
  cursor: string | undefined,
  binding: ProjectPageCursorBinding,
): number {
  if (cursor === undefined) return 0;
  const payload = decodeCursor(cursor);
  const targetsCurrentQuery = payload.q === binding.query;
  if (!targetsCurrentQuery) {
    throw new ProjectInspectionError(
      "project_cursor_query_mismatch",
      "The project cursor belongs to a different target or depth. Start a fresh inspection without a cursor.",
    );
  }
  const targetsCurrentListing = payload.l === binding.listing;
  if (!targetsCurrentListing) {
    throw new ProjectInspectionError(
      "project_cursor_stale",
      "The project listing changed. Start a fresh inspection without a cursor.",
    );
  }
  if (payload.o >= binding.entryCount) invalidCursor();
  return payload.o;
}
