import {
  InformationBasketError, type BasketReadInput, type BasketReadResult, type BasketSourceRevision,
} from "./contracts.js";
import type { BasketSnapshot, BasketSourceReader, StoredBasketSource } from "./index-records.js";
import { BASKET_LIMITS } from "./limits.js";
import { isBasketRevision, isBasketSourceId } from "./snapshot-validation.js";
import type { BasketStateOwner } from "./state-owner.js";

export function requireBasketSource(state: BasketSnapshot, input: BasketSourceRevision): StoredBasketSource {
  if (!isBasketSourceId(input.sourceId)) throw new InformationBasketError("basket_source_id_invalid");
  if (!isBasketRevision(input.expectedRevision)) throw new InformationBasketError("basket_source_revision_invalid");
  const source = state.sources.find(entry => entry.sourceId === input.sourceId);
  if (!source) throw new InformationBasketError("basket_source_not_found", undefined, 404);
  if (source.revision !== input.expectedRevision)
    throw new InformationBasketError("basket_source_revision_conflict", undefined, 409);
  return source;
}
function readWindowInteger(value: number | undefined, defaultValue: number, maximum: number): number {
  const result = value ?? defaultValue;
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum)
    throw new InformationBasketError("basket_read_window_invalid");
  return result;
}

export function createBasketSourceReading(state: BasketStateOwner, reader: BasketSourceReader) {
  return async (input: BasketReadInput): Promise<BasketReadResult> => {
    input.abortSignal?.throwIfAborted();
    const snapshot = await state.read();
    if (!snapshot.settings.enabled) throw new InformationBasketError("basket_disabled", undefined, 409);
    const source = requireBasketSource(snapshot, input);
    if (source.status !== "ready" || !source.index)
      throw new InformationBasketError("basket_source_not_ready", undefined, 409);
    const start = readWindowInteger(input.startChar, 0, BASKET_LIMITS.maxTextCharacters);
    const maximum = readWindowInteger(input.maxChars, 8_000, BASKET_LIMITS.maxReadCharacters);
    if (maximum === 0) throw new InformationBasketError("basket_read_window_invalid");
    let document;
    try {
      document = await reader(source.path, input.abortSignal);
    } catch (error) {
      if (input.abortSignal?.aborted) throw error;
      const missing = error instanceof InformationBasketError && error.code === "basket_source_not_found";
      await state.update(current => ({
        ...current,
        sources: current.sources.map(entry => entry.sourceId === source.sourceId && entry.revision === source.revision
          ? { ...entry, status: missing ? "missing" : "stale", index: null, chunkCount: 0,
              reason: missing ? "basket_source_not_found" : "basket_source_unavailable" } : entry),
      }));
      throw error;
    }
    const matchesIndex = document.contentHash === source.index.contentHash
      && document.fileIdentity === source.index.fileIdentity;
    if (!matchesIndex) {
      await state.update(current => ({
        ...current,
        sources: current.sources.map(entry => entry.sourceId === source.sourceId && entry.revision === source.revision
          ? { ...entry, status: "stale", index: null, chunkCount: 0, reason: "basket_source_changed" } : entry),
      }));
      throw new InformationBasketError("basket_source_stale", undefined, 409);
    }
    input.abortSignal?.throwIfAborted();
    const latest = await state.read();
    if (!latest.settings.enabled) throw new InformationBasketError("basket_disabled", undefined, 409);
    const stillRegistered = requireBasketSource(latest, input);
    if (stillRegistered.status !== "ready") throw new InformationBasketError("basket_source_stale", undefined, 409);
    const startChar = Math.min(start, document.text.length);
    const endChar = Math.min(document.text.length, startChar + maximum);
    return Object.freeze({
      sourceId: source.sourceId, expectedRevision: source.revision, displayName: source.displayName,
      path: source.path, contentHash: document.contentHash, text: document.text.slice(startChar, endChar),
      startChar, endChar, totalCharacters: document.text.length, omittedBefore: startChar,
      omittedAfter: document.text.length - endChar, nextStartChar: endChar < document.text.length ? endChar : null,
    });
  };
}
