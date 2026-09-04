import { parsePublicHttpUrl } from "../network-policy.js";
import type { LightConfig } from "./config.js";
import type { DiscoveryCandidate } from "./documents/document-contract.js";
import { countTermMatches } from "./ranking/query-normalization.js";
import type { LightSource } from "./sources/source-definition.js";

export type LightCrawlCandidate = DiscoveryCandidate &
  Readonly<{
    source: LightSource;
    depth: number;
    priority: number;
    sequence: number;
    queryScores: readonly number[];
    entry: boolean;
  }>;

function admittedCandidateUrl(
  url: string,
  source: LightSource,
): string | undefined {
  try {
    const parsed = parsePublicHttpUrl(url);
    if (!source.allowedOrigins.includes(parsed.origin)) return undefined;
    parsed.hash = "";
    if (parsed.toString().length > 1_024) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function createSearchFrontier(
  queries: readonly string[],
  config: LightConfig,
) {
  const seen = new Set<string>();
  const pending: LightCrawlCandidate[] = [];
  const sourcesWithEntryOpportunity = new Set<string>();
  let sequence = 0;
  let omitted = 0;
  let sitemapCount = 0;
  let nextQuery = 0;

  function replacementIndex(incoming: LightCrawlCandidate): number {
    const sourceCounts = new Map<string, number>();
    const queryCounts = queries.map(() => 0);
    for (const candidate of pending) {
      sourceCounts.set(
        candidate.source.id,
        (sourceCounts.get(candidate.source.id) ?? 0) + 1,
      );
      candidate.queryScores.forEach((score, index) => {
        if (score > 0) queryCounts[index]! += 1;
      });
    }
    const candidates = pending
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => !needsFirstEntryOpportunity(candidate))
      .sort(
        (left, right) =>
          left.candidate.priority - right.candidate.priority ||
          right.candidate.sequence - left.candidate.sequence,
      );
    const match = candidates.find(({ candidate }) =>
      canReplaceCandidate(candidate, incoming, sourceCounts, queryCounts),
    );
    return match?.index ?? -1;
  }

  function enqueue(
    candidate: DiscoveryCandidate,
    source: LightSource,
    depth: number,
    entry = false,
  ): void {
    if (depth > config.maxDepth) {
      omitted += 1;
      return;
    }
    const url = admittedCandidateUrl(candidate.url, source);
    if (!url) return;
    if (seen.has(url)) return;
    if (candidate.kind === "sitemap" && sitemapCount >= config.maxSitemaps) {
      omitted += 1;
      return;
    }
    const queryScores = queries.map((query) =>
      countTermMatches(
        query,
        `${candidate.title} ${candidate.text ?? ""} ${decodeURIComponentSafe(url)}`,
      ),
    );
    const relevance = Math.max(0, ...queryScores);
    const priority = entry ? 1_000 - sequence : relevance * 100 - depth * 10;
    const incoming = Object.freeze({
      ...candidate,
      url,
      source,
      depth,
      priority,
      sequence: sequence++,
      queryScores: Object.freeze(queryScores),
      entry,
    });
    if (seen.size >= config.maxCandidates) {
      omitted += 1;
      const index = replacementIndex(incoming);
      if (index < 0) return;
      seen.delete(pending[index]!.url);
      pending.splice(index, 1);
    }
    seen.add(url);
    if (candidate.kind === "sitemap") sitemapCount += 1;
    pending.push(incoming);
  }

  function needsFirstEntryOpportunity(candidate: LightCrawlCandidate): boolean {
    if (!candidate.entry) return false;
    return !sourcesWithEntryOpportunity.has(candidate.source.id);
  }

  function nextCandidateIndex(origins: ReadonlySet<string>): number {
    const available = pending
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => !origins.has(new URL(candidate.url).origin));
    const entry = available.find(({ candidate }) =>
      needsFirstEntryOpportunity(candidate),
    );
    if (entry) return entry.index;
    for (let offset = 0; offset < queries.length; offset += 1) {
      const queryIndex = (nextQuery + offset) % queries.length;
      const matching = available
        .filter(({ candidate }) => candidate.queryScores[queryIndex]! > 0)
        .sort((left, right) =>
          compareCandidatesForQuery(
            left.candidate,
            right.candidate,
            queryIndex,
          ),
        );
      const match = matching[0];
      if (!match) continue;
      nextQuery = (queryIndex + 1) % queries.length;
      return match.index;
    }
    return available[0]?.index ?? -1;
  }

  function nextBatch(): readonly LightCrawlCandidate[] {
    pending.sort(
      (left, right) =>
        right.priority - left.priority || left.sequence - right.sequence,
    );
    const batch: LightCrawlCandidate[] = [];
    const origins = new Set<string>();
    while (batch.length < config.maxConcurrency) {
      const index = nextCandidateIndex(origins);
      if (index < 0) break;
      const candidate = pending[index]!;
      const origin = new URL(candidate.url).origin;
      origins.add(origin);
      if (candidate.entry) sourcesWithEntryOpportunity.add(candidate.source.id);
      batch.push(candidate);
      pending.splice(index, 1);
    }
    return Object.freeze(batch);
  }

  return Object.freeze({
    enqueue,
    nextBatch,
    hasPending: () => pending.length > 0,
    omitted: () => omitted,
    discovered: () => seen.size,
  });
}

function compareCandidatesForQuery(
  left: LightCrawlCandidate,
  right: LightCrawlCandidate,
  queryIndex: number,
): number {
  const relevanceDifference =
    right.queryScores[queryIndex]! - left.queryScores[queryIndex]!;
  if (relevanceDifference !== 0) return relevanceDifference;
  // After each source has had an entry opportunity, useful discovered content
  // wins a relevance tie with another entry URL from an already-started source.
  if (left.entry !== right.entry) return left.entry ? 1 : -1;
  return left.sequence - right.sequence;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function preservesExistingQueryCoverage(
  existing: LightCrawlCandidate,
  incoming: LightCrawlCandidate,
  queryCounts: readonly number[],
): boolean {
  for (let index = 0; index < queryCounts.length; index += 1) {
    if (existing.queryScores[index] === 0) continue;
    if (incoming.queryScores[index]! > 0) continue;
    if (queryCounts[index]! > 1) continue;
    return false;
  }
  return true;
}

function canReplaceSupplementalEntry(
  existing: LightCrawlCandidate,
  incoming: LightCrawlCandidate,
  queryCounts: readonly number[],
): boolean {
  if (!existing.entry) return false;
  if (incoming.entry) return false;
  if (!incoming.queryScores.some((score) => score > 0)) return false;
  return preservesExistingQueryCoverage(existing, incoming, queryCounts);
}

function canReplaceCandidate(
  existing: LightCrawlCandidate,
  incoming: LightCrawlCandidate,
  sourceCounts: ReadonlyMap<string, number>,
  queryCounts: readonly number[],
): boolean {
  if (incoming.entry) return true;
  if (canReplaceSupplementalEntry(existing, incoming, queryCounts)) return true;
  const addsQueryCoverage = incoming.queryScores.some(
    (score, index) => score > 0 && queryCounts[index] === 0,
  );
  if (
    addsQueryCoverage &&
    preservesExistingQueryCoverage(existing, incoming, queryCounts)
  )
    return true;
  const existingCount = sourceCounts.get(existing.source.id) ?? 0;
  const incomingCount = sourceCounts.get(incoming.source.id) ?? 0;
  if (existingCount > incomingCount + 1) return true;
  if (existing.source.id !== incoming.source.id) return false;
  return incoming.priority > existing.priority;
}
