import { setImmediate } from "node:timers/promises";
import {
  InformationBasketError, type BasketMatchMode, type BasketReadInput, type BasketReadResult, type BasketSearchCandidate,
  type BasketSearchInput, type BasketSearchResult, type InformationBasketOptions,
} from "./contracts.js";
import { embedBasketTexts } from "./embedding.js";
import type { BasketIndexedChunk, BasketSnapshot, StoredBasketSource } from "./index-records.js";
import { BASKET_LIMITS } from "./limits.js";
import { basketProfileSignature } from "./profile-binding.js";
import { basketSourceNameMatchRank } from "./source-name-matching.js";
import type { BasketStateOwner } from "./state-owner.js";

const MATCH_MODE_MINIMUM_SIMILARITY: Readonly<Record<BasketMatchMode, number>> = Object.freeze({
  flexible: 0.3, balanced: 0.6, strict: 0.9,
});

const empty = (): BasketSearchResult => ({ status: "empty", sources: [], omittedCount: 0 });
const unavailable = (reason: string): BasketSearchResult => ({ status: "unavailable", sources: [], omittedCount: 0, reason });

function hasCurrentBasketSearchSettings(state: BasketStateOwner, version: number): boolean {
  return state.retrievalSettingsVersion() === version;
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
function canIncludeBasketSearchChunk(nameMatchRank: number, score: number, minimumSimilarity: number): boolean {
  if (nameMatchRank > 0) return true;
  return score >= minimumSimilarity;
}

function compareBasketSourceCandidates(
  left: BasketSearchCandidate, right: BasketSearchCandidate, nameMatchRanks: ReadonlyMap<string, number>,
): number {
  const nameOrder = (nameMatchRanks.get(right.sourceId) ?? 0) - (nameMatchRanks.get(left.sourceId) ?? 0);
  if (nameOrder !== 0) return nameOrder;
  const scoreOrder = right.score - left.score;
  if (scoreOrder !== 0) return scoreOrder;
  return left.sourceId.localeCompare(right.sourceId);
}

async function rankBasketSources(
  sources: readonly StoredBasketSource[],
  query: readonly number[],
  signal: AbortSignal,
  minimumSimilarity: number,
  queryText: string,
): Promise<readonly BasketSearchCandidate[]> {
  const candidates: BasketSearchCandidate[] = [];
  const nameMatchRanks = new Map<string, number>();
  let visited = 0;
  for (const source of sources) {
    const nameMatchRank = basketSourceNameMatchRank(queryText, source.displayName);
    const matches: { chunk: BasketIndexedChunk; score: number }[] = [];
    for (const chunk of source.index!.chunks) {
      signal.throwIfAborted();
      const score = normalizedSimilarity(query, chunk.vector);
      if (++visited % 128 === 0) await setImmediate();
      if (!canIncludeBasketSearchChunk(nameMatchRank, score, minimumSimilarity)) continue;
      matches.push({ chunk, score });
      matches.sort((a, b) => b.score - a.score || a.chunk.startChar - b.chunk.startChar);
      if (matches.length > 3) matches.pop();
    }
    if (!matches.length) continue;
    nameMatchRanks.set(source.sourceId, nameMatchRank);
    candidates.push(Object.freeze({
      sourceId: source.sourceId, expectedRevision: source.revision,
      displayName: source.displayName, path: source.path, score: matches[0]!.score,
      matches: Object.freeze(matches.map(({ chunk }) => Object.freeze({
        chunkId: chunk.chunkId, startChar: chunk.startChar, endChar: chunk.endChar,
      }))),
    }));
  }
  return candidates.sort((a, b) => compareBasketSourceCandidates(a, b, nameMatchRanks));
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
      const settingsVersion = options.state.retrievalSettingsVersion();
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
      const ranked = await rankBasketSources(compatible, embedded.vectors[0]!, signal,
        MATCH_MODE_MINIMUM_SIMILARITY[snapshot.settings.matchMode], query);
      // Only verified candidates count as matches, including omitted-result counts.
      const candidates = ranked.slice(0, BASKET_LIMITS.maxSearchSources);
      const candidateIds = new Set(candidates.map(candidate => candidate.sourceId));
      await options.validateSources(compatible.filter(source => candidateIds.has(source.sourceId)), signal);
      const current = await options.state.read();
      if (!hasCurrentBasketSearchSettings(options.state, settingsVersion))
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
      if (!hasCurrentBasketSearchSettings(options.state, settingsVersion))
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
