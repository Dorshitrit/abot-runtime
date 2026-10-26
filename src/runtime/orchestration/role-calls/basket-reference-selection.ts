import { isBasketSourceId, isBasketRevision } from "../../information-basket/snapshot-validation.js";
import { BASKET_LIMITS } from "../../information-basket/limits.js";
import { isRecord } from "../../validation/strict-record.js";

export type BasketReferenceSelection =
  | Readonly<{ action: "search_information_sources"; query: string }>
  | Readonly<{ action: "read_information_source"; sourceId: string; expectedRevision: number; startChar: number; maxChars: number }>;

/** Historical native SUPER receipt validation; never offered as a model action. */
export function basketReferenceSelection(record: unknown): BasketReferenceSelection | undefined {
  if (!isRecord(record)) return undefined;
  if (record.action === "search_information_sources") {
    if (!boundedText(record.query, BASKET_LIMITS.maxQueryCharacters)) return undefined;
    return { action: record.action, query: record.query };
  }
  if (record.action !== "read_information_source") return undefined;
  if (!isBasketSourceId(record.sourceId) || !isBasketRevision(record.expectedRevision)) return undefined;
  if (!nonnegativeInteger(record.startChar) || record.startChar > BASKET_LIMITS.maxTextCharacters) return undefined;
  if (!nonnegativeInteger(record.maxChars) || record.maxChars < 1 || record.maxChars > BASKET_LIMITS.maxReadCharacters) return undefined;
  return {
    action: record.action, sourceId: record.sourceId, expectedRevision: record.expectedRevision,
    startChar: record.startChar, maxChars: record.maxChars,
  };
}

function boundedText(value: unknown, maximum: number, minimum = 1): value is string {
  if (typeof value !== "string") return false;
  if (value.length > maximum) return false;
  return value.trim().length >= minimum;
}
function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
