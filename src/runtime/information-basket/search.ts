import { setImmediate } from "node:timers/promises";
import {
  InformationBasketError, type BasketReadInput, type BasketReadResult, type BasketSearchCandidate,
  type BasketSearchInput, type BasketSearchResult, type InformationBasketOptions,
} from "./contracts.js";
import { embedBasketTexts } from "./embedding.js";
import type { BasketIndexedChunk, BasketSnapshot, StoredBasketSource } from "./index-records.js";
import { BASKET_LIMITS } from "./limits.js";
import { basketProfileSignature } from "./profile-binding.js";
import type { BasketStateOwner } from "./state-owner.js";

const empty = (): BasketSearchResult => ({ status: "empty", sources: [], omittedCount: 0 });
const unavailable = (reason: string): BasketSearchResult => ({ status: "unavailable", sources: [], omittedCount: 0, reason });

function hasCurrentBasketSearchSettings(state: BasketSnapshot, settingsRevision: number): boolean {
  if (!state.settings.enabled) return false;
  return state.settings.revision === settingsRevision;
}
function hasCurrentBasketSearchSource(state: BasketSnapshot, candidate: BasketSearchCandidate): boolean {
  return state.sources.some(source => source.sourceId === candidate.sourceId
    && source.revision === candidate.expectedRevision && source.status === "ready");
}

function normalizedSimilarity(left: readonly number[], right: readonly number[]): number {
  let result = 0;
  for (let i = 0; i < left.length; i++) result += left[i]! * right[i]!;
  return Math.max(-1, Math.min(1, result));
}
async function rankBasketSources(
  sources: readonly StoredBasketSource[],
  query: readonly number[],
  signal: AbortSignal,
): Promise<readonly BasketSearchCandidate[]> {
  const candidates: BasketSearchCandidate[] = [];
  let visited = 0;
  for (const source of sources) {
    const matches: { chunk: BasketIndexedChunk; score: number }[] = [];
    for (const chunk of source.index!.chunks) {
      signal.throwIfAborted();
      const score = normalizedSimilarity(query, chunk.vector);
      if (score >= BASKET_LIMITS.minimumSimilarity) {
        matches.push({ chunk, score });
        matches.sort((a, b) => b.score - a.score || a.chunk.startChar - b.chunk.startChar);
        if (matches.length > 3) matches.pop();
      }
      if (++visited % 128 === 0) await setImmediate();
    }
    if (!matches.length) continue;
    candidates.push(Object.freeze({
      sourceId: source.sourceId, expectedRevision: source.revision,
      displayName: source.displayName, path: source.path, score: matches[0]!.score,
      matches: Object.freeze(matches.map(({ chunk }) => Object.freeze({
        chunkId: chunk.chunkId, startChar: chunk.startChar, endChar: chunk.endChar,
      }))),
    }));
  }
  return candidates.sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId));
}

export function createBasketSearch(options: InformationBasketOptions & {
  state: BasketStateOwner;
  readSource(input: BasketReadInput): Promise<BasketReadResult>;
  validateSources(sources: readonly StoredBasketSource[], signal: AbortSignal): Promise<void>;
}) {
  return async (input: BasketSearchInput): Promise<BasketSearchResult> => {
    input.abortSignal.throwIfAborted();
    if (typeof input.query !== "string" || input.query.length > BASKET_LIMITS.maxQueryCharacters)
      return unavailable("basket_query_invalid");
    const query = input.query.trim();
    if (!query) return empty();
    const maximum = input.maxSources ?? 5;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > BASKET_LIMITS.maxSearchSources)
      return unavailable("basket_search_limit_invalid");
    const signal = AbortSignal.any([input.abortSignal, AbortSignal.timeout(BASKET_LIMITS.searchTimeoutMs)]);
    try {
      const snapshot = await options.state.read();
      if (!snapshot.settings.enabled) return unavailable("basket_disabled");
      if (!snapshot.sources.length) return empty();
      const profileId = snapshot.settings.embeddingProfileId;
      if (!profileId) return unavailable("basket_embedding_profile_required");
      const signature = basketProfileSignature(options.config, profileId);
      const ready = snapshot.sources.filter(source => source.status === "ready"
        && source.index?.profileSignature === signature);
      if (!ready.length) return unavailable("basket_index_not_ready");
      const embedded = await embedBasketTexts({ ...options, profileId, texts: [query], abortSignal: signal });
      const compatible = ready.filter(source => source.index!.modelFingerprint === embedded.modelFingerprint
        && source.index!.dimensions === embedded.dimensions);
      if (!compatible.length) return unavailable("basket_embedding_binding_changed");
      const ranked = await rankBasketSources(compatible, embedded.vectors[0]!, signal);
      // Only verified candidates count as matches, including omitted-result counts.
      const candidates = ranked.slice(0, BASKET_LIMITS.maxSearchSources);
      const candidateIds = new Set(candidates.map(candidate => candidate.sourceId));
      await options.validateSources(compatible.filter(source => candidateIds.has(source.sourceId)), signal);
      const current = await options.state.read();
      if (!hasCurrentBasketSearchSettings(current, snapshot.settings.revision))
        return unavailable("basket_search_superseded");
      const remaining = candidates.filter(candidate => hasCurrentBasketSearchSource(current, candidate));
      const selected: BasketSearchCandidate[] = [];
      for (const candidate of remaining.slice(0, maximum)) {
        signal.throwIfAborted();
        if (!input.includeExcerpts) { selected.push(candidate); continue; }
        try {
          const preview = await options.readSource({
            sourceId: candidate.sourceId, expectedRevision: candidate.expectedRevision,
            startChar: candidate.matches[0]!.startChar, maxChars: BASKET_LIMITS.previewCharacters, abortSignal: signal,
          });
          selected.push(Object.freeze({ ...candidate, excerpt: preview.text }));
        } catch (error) {
          if (signal.aborted) throw error;
          // Stale or removed candidates are omitted, never filled from the vector.
        }
      }
      signal.throwIfAborted();
      const finalSnapshot = await options.state.read();
      if (!hasCurrentBasketSearchSettings(finalSnapshot, snapshot.settings.revision))
        return unavailable("basket_search_superseded");
      const finalSources = selected.filter(candidate => hasCurrentBasketSearchSource(finalSnapshot, candidate));
      const finalRankedCount = remaining.filter(candidate => hasCurrentBasketSearchSource(finalSnapshot, candidate)).length;
      return Object.freeze({
        status: finalSources.length ? "found" : "empty", sources: Object.freeze(finalSources),
        omittedCount: Math.max(0, finalRankedCount - finalSources.length),
      });
    } catch (error) {
      if (input.abortSignal.aborted) throw error;
      if (signal.aborted) return unavailable("basket_search_timeout");
      return unavailable(error instanceof InformationBasketError ? error.code : "basket_search_unavailable");
    }
  };
}
