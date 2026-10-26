import { BASKET_LIMITS } from "../../information-basket/limits.js";
import { isBasketSourceId, isBasketRevision } from "../../information-basket/snapshot-validation.js";
import { exactKeys, isRecord } from "../../validation/strict-record.js";
import type { BasketReferenceSelection } from "./basket-reference-selection.js";

/** Validate persisted source identities and complete bounded receipts before restore. */
export function isBasketReferenceResult(value: unknown, selection: BasketReferenceSelection): boolean {
  if (!isRecord(value)) return false;
  if (value.outcome === "failed")
    return exactKeys(value, ["outcome", "errorCode"]) && typeof value.errorCode === "string" &&
      value.errorCode.length <= 200 && /^[a-z][a-z0-9_]*$/.test(value.errorCode);
  if (value.outcome !== "completed" || !exactKeys(value, ["outcome", "data"])) return false;
  if (selection.action === "search_information_sources") return isSearchData(value.data);
  return isReadData(value.data, selection);
}

function isSearchData(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!exactKeys(value, ["status", "sources", "omittedCount"], ["reason"])) return false;
  if (!["found", "empty", "unavailable"].includes(value.status as string)) return false;
  if (!nonnegativeInteger(value.omittedCount)) return false;
  if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 200)) return false;
  if (!Array.isArray(value.sources) || value.sources.length > BASKET_LIMITS.maxSearchSources) return false;
  if (!value.sources.every(isSourceCandidate)) return false;
  if (new Set(value.sources.map((source) => source.sourceId)).size !== value.sources.length) return false;
  return value.status === "found" ? value.sources.length > 0 : value.sources.length === 0;
}

function isSourceCandidate(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (!exactKeys(value, ["sourceId", "expectedRevision", "displayName", "path", "score", "matches"], ["excerpt"])) return false;
  if (!hasSourceIdentity(value)) return false;
  if (typeof value.score !== "number" || !Number.isFinite(value.score)) return false;
  if (value.excerpt !== undefined && (typeof value.excerpt !== "string" || value.excerpt.length > BASKET_LIMITS.previewCharacters)) return false;
  if (!Array.isArray(value.matches) || value.matches.length > 3) return false;
  return value.matches.every((match) => {
    if (!isRecord(match) || !exactKeys(match, ["chunkId", "startChar", "endChar"])) return false;
    if (typeof match.chunkId !== "string" || !/^chunk-([0-9]+)$/.test(match.chunkId)) return false;
    if (Number(match.chunkId.slice(6)) >= BASKET_LIMITS.maxChunks) return false;
    if (!nonnegativeInteger(match.startChar) || !nonnegativeInteger(match.endChar)) return false;
    return match.endChar > match.startChar && match.endChar <= BASKET_LIMITS.maxTextCharacters;
  });
}

function isReadData(value: unknown, selection: Extract<BasketReferenceSelection, { action: "read_information_source" }>): boolean {
  if (!isRecord(value)) return false;
  if (!exactKeys(value, ["sourceId", "expectedRevision", "displayName", "path", "contentHash", "text",
    "startChar", "endChar", "totalCharacters", "omittedBefore", "omittedAfter", "nextStartChar"])) return false;
  if (!hasSourceIdentity(value)) return false;
  if (value.sourceId !== selection.sourceId || value.expectedRevision !== selection.expectedRevision) return false;
  if (typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash)) return false;
  if (typeof value.text !== "string" || value.text.length > selection.maxChars) return false;
  if (!nonnegativeInteger(value.startChar) || !nonnegativeInteger(value.endChar) ||
    !nonnegativeInteger(value.totalCharacters) || !nonnegativeInteger(value.omittedBefore) ||
    !nonnegativeInteger(value.omittedAfter)) return false;
  if (value.totalCharacters > BASKET_LIMITS.maxTextCharacters) return false;
  if (value.startChar !== Math.min(selection.startChar, value.totalCharacters) || value.endChar < value.startChar) return false;
  if (value.endChar - value.startChar !== value.text.length) return false;
  if (value.omittedBefore !== value.startChar || value.omittedAfter !== value.totalCharacters - value.endChar) return false;
  return value.nextStartChar === (value.omittedAfter > 0 ? value.endChar : null);
}

function hasSourceIdentity(value: Record<string, unknown>): boolean {
  if (!isBasketSourceId(value.sourceId) || !isBasketRevision(value.expectedRevision)) return false;
  if (typeof value.displayName !== "string" || typeof value.path !== "string") return false;
  if (value.displayName.length > 4096 || value.path.length > 4096) return false;
  return true;
}
function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
