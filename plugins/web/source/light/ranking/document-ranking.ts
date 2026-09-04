import type {
  QueryResult,
  SearchHit,
  SourceFetch,
} from "../../search-types.js";
import { WEB_LIMITS } from "../../limits.js";
import type { LightCachedDocument } from "../documents/document-cache.js";
import { queryTerms, textTerms } from "./query-normalization.js";

type ScoredDocument = Readonly<{ record: LightCachedDocument; score: number }>;

function isIndexablePage(record: LightCachedDocument): boolean {
  if (record.document.noIndex) return false;
  return record.document.kind === "page";
}

function scoreDocument(query: string, record: LightCachedDocument): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const titleTerms = queryTerms(record.document.title);
  const title = new Set(titleTerms);
  const body = textTerms(record.document.text);
  const frequencies = new Map<string, number>();
  for (const term of body)
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  let score = 0;
  let matched = 0;
  let titleMatches = 0;
  for (const term of terms) {
    const inTitle = title.has(term);
    const frequency = frequencies.get(term) ?? 0;
    if (!inTitle && frequency === 0) continue;
    matched += 1;
    if (inTitle) titleMatches += 1;
    score +=
      Math.log1p(Math.min(frequency, 3)) / Math.sqrt(1 + body.length / 200);
  }
  if (matched === 0) return 0;
  const titleConcentration = titleMatches / Math.max(1, title.size);
  score += 8 * titleMatches * (0.5 + titleConcentration);
  const hasExactTopicTitle = titleTerms.join(" ") === terms.join(" ");
  if (hasExactTopicTitle) score += 6;
  return (score * matched) / terms.length;
}

function publishedTime(record: LightCachedDocument): number {
  const date = record.document.publishedAt ?? record.document.updatedAt;
  return date ? Date.parse(date) || 0 : 0;
}

function compareDocuments(left: ScoredDocument, right: ScoredDocument): number {
  return (
    right.score - left.score ||
    publishedTime(right.record) - publishedTime(left.record) ||
    left.record.document.canonicalUrl.localeCompare(
      right.record.document.canonicalUrl,
    )
  );
}

function documentSnippet(query: string, text: string): string {
  const terms = queryTerms(query);
  const paragraphs = text
    .split(/\n+/u)
    .map((paragraph, index) => ({
      paragraph,
      index,
      matches: terms.filter((term) => new Set(textTerms(paragraph)).has(term))
        .length,
    }))
    .sort(
      (left, right) => right.matches - left.matches || left.index - right.index,
    );
  return (paragraphs[0]?.paragraph ?? text).slice(0, 800);
}

export function rankLightDocuments(
  queries: readonly string[],
  records: readonly LightCachedDocument[],
) {
  const byUrl = new Map(
    records.map((record) => [record.document.canonicalUrl, record]),
  );
  const results: QueryResult[] = queries.map((query) => {
    const ranked = [...byUrl.values()]
      .filter(isIndexablePage)
      .map((record) => ({ record, score: scoreDocument(query, record) }))
      .filter(({ score }) => score > 0)
      .sort(compareDocuments)
      .slice(0, WEB_LIMITS.searchResultsPerQuery);
    const hits: SearchHit[] = ranked.map(({ record }, index) => ({
      query,
      title: record.document.title || record.document.canonicalUrl,
      url: record.document.canonicalUrl,
      domain: new URL(record.document.canonicalUrl).hostname,
      snippet: documentSnippet(query, record.document.text),
      rank: index + 1,
    }));
    return Object.freeze({ query, hits: Object.freeze(hits) });
  });
  const hits = [
    ...new Map(
      results.flatMap((result) => result.hits).map((hit) => [hit.url, hit]),
    ).values(),
  ];
  const sourceFetches: SourceFetch[] = hits
    .slice(0, WEB_LIMITS.searchSourceFetches)
    .map((hit) => ({ hit, page: byUrl.get(hit.url)?.page }));
  return Object.freeze({
    results: Object.freeze(results),
    hits: Object.freeze(hits),
    sourceFetches: Object.freeze(sourceFetches),
  });
}
