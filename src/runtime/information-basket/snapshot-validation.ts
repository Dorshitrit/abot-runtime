import { isAbsolute } from "node:path";
import { InformationBasketError, type BasketSettings, type BasketSourceStatus } from "./contracts.js";
import type { BasketSnapshot, BasketSourceIndex, StoredBasketSource } from "./index-records.js";
import { BASKET_LIMITS } from "./limits.js";

const SOURCE_ID = /^basket-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STATUSES = new Set<BasketSourceStatus>([
  "queued", "indexing", "ready", "stale", "missing", "failed", "unsupported",
]);

export function isBasketSourceId(value: unknown): value is string {
  return typeof value === "string" && SOURCE_ID.test(value);
}
export function isBasketRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function failStorage(): never { throw new InformationBasketError("basket_storage_invalid", undefined, 503); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failStorage();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum) return failStorage();
  return value;
}
function count(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    return failStorage();
  return value;
}
function optionalText(value: unknown, maximum: number): string | null {
  return value === null ? null : text(value, maximum);
}
function parseSettings(value: unknown): BasketSettings {
  const settings = object(value);
  if (!isBasketRevision(settings.revision) || typeof settings.enabled !== "boolean") return failStorage();
  return Object.freeze({
    revision: settings.revision, enabled: settings.enabled,
    embeddingProfileId: optionalText(settings.embeddingProfileId, 512),
  });
}
function parseIndex(value: unknown): BasketSourceIndex | null {
  if (value === null) return null;
  const index = object(value);
  const dimensions = count(index.dimensions, BASKET_LIMITS.maxDimensions);
  if (!dimensions || index.chunkingVersion !== 1) return failStorage();
  const totalCharacters = count(index.totalCharacters, BASKET_LIMITS.maxTextCharacters);
  if (!Array.isArray(index.chunks) || index.chunks.length > BASKET_LIMITS.maxChunks) return failStorage();
  const chunks = index.chunks.map((value, position) => {
    const chunk = object(value);
    const startChar = count(chunk.startChar, totalCharacters);
    const endChar = count(chunk.endChar, totalCharacters);
    if (endChar <= startChar || chunk.chunkId !== "chunk-" + position) return failStorage();
    if (!Array.isArray(chunk.vector) || chunk.vector.length !== dimensions) return failStorage();
    const vector = chunk.vector.map((entry: unknown) => {
      if (typeof entry !== "number" || !Number.isFinite(entry) || Math.abs(entry) > 1.000001)
        return failStorage();
      return entry;
    });
    const magnitude = vector.reduce((sum, entry) => sum + entry * entry, 0);
    if (Math.abs(magnitude - 1) > 0.0001) return failStorage();
    return Object.freeze({ chunkId: chunk.chunkId as string, startChar, endChar, vector: Object.freeze(vector) });
  });
  if (!chunks.length || chunks[0]!.startChar !== 0 || chunks.at(-1)!.endChar !== totalCharacters)
    return failStorage();
  return Object.freeze({
    contentHash: text(index.contentHash, 64), fileIdentity: text(index.fileIdentity, 512),
    chunkingVersion: 1, totalCharacters,
    profileSignature: text(index.profileSignature, 64), modelFingerprint: text(index.modelFingerprint, 2_048),
    dimensions, chunks: Object.freeze(chunks),
  });
}
function parseSource(value: unknown): StoredBasketSource {
  const source = object(value);
  if (!isBasketSourceId(source.sourceId) || !isBasketRevision(source.revision)) return failStorage();
  const path = text(source.path, 4_096);
  if (!isAbsolute(path) || path.includes("\0")) return failStorage();
  const status = source.status as BasketSourceStatus;
  if (!STATUSES.has(status)) return failStorage();
  const index = parseIndex(source.index);
  const chunkCount = count(source.chunkCount, BASKET_LIMITS.maxChunks);
  if (status === "ready" && !index) return failStorage();
  if (index && chunkCount !== index.chunks.length) return failStorage();
  if (!index && chunkCount !== 0) return failStorage();
  return Object.freeze({
    sourceId: source.sourceId, displayName: text(source.displayName, 4_096), path,
    revision: source.revision, status, index, chunkCount,
    indexedAt: optionalText(source.indexedAt, 100), reason: optionalText(source.reason, 160),
    sizeBytes: source.sizeBytes === null ? null : count(source.sizeBytes, BASKET_LIMITS.maxSourceBytes),
  });
}
export function parseBasketSnapshot(value: unknown, hostNamespace: string): BasketSnapshot {
  const snapshot = object(value);
  if (snapshot.schemaVersion !== 1) return failStorage();
  if (snapshot.hostNamespace !== hostNamespace)
    throw new InformationBasketError("basket_storage_host_mismatch", undefined, 409);
  if (!Array.isArray(snapshot.sources) || snapshot.sources.length > BASKET_LIMITS.maxSources) return failStorage();
  const sources = snapshot.sources.map(parseSource);
  if (new Set(sources.map(source => source.sourceId)).size !== sources.length) return failStorage();
  if (new Set(sources.map(source => source.path)).size !== sources.length) return failStorage();
  return Object.freeze({ schemaVersion: 1, hostNamespace, settings: parseSettings(snapshot.settings), sources: Object.freeze(sources) });
}
