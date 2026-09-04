import { isWebPluginError } from "../errors.js";
import type { LightConfig } from "./config.js";
import type { LightCrawlSession } from "./crawl/transport.js";
import type {
  LightCachedDocument,
  LightDocumentCache,
} from "./documents/document-cache.js";
import { readLightDocument } from "./documents/document-reader.js";
import {
  createSearchFrontier,
  type LightCrawlCandidate,
} from "./search-frontier.js";
import type { LightSource } from "./sources/source-definition.js";

export type LightSourceFailure = Readonly<{
  url: string;
  errorCode: string;
  error: string;
}>;

function isTerminalSearchError(error: unknown): boolean {
  if (!isWebPluginError(error)) return false;
  return error.code === "web_request_aborted";
}

export async function collectLightDocuments(params: {
  queries: readonly string[];
  sources: readonly LightSource[];
  config: LightConfig;
  session: LightCrawlSession;
  cache: LightDocumentCache;
}) {
  const { session, config, cache, sources } = params;
  const records = new Map(
    cache
      .forSources(new Set(config.sources.map(({ id }) => id)))
      .map((record) => [record.document.canonicalUrl, record]),
  );
  const fetchedUrls = new Set<string>();
  const consultedSources = new Set<string>();
  const failures: LightSourceFailure[] = [];
  const frontier = createSearchFrontier(params.queries, config);
  let cacheHits = 0;
  let cacheMisses = 0;
  let successfulReads = 0;

  // Round-robin entry admission gives every selected source a first opportunity.
  const entryCount = Math.max(
    ...sources.map(({ entryUrls }) => entryUrls.length),
  );
  for (let index = 0; index < entryCount; index += 1) {
    for (const source of sources) {
      const url = source.entryUrls[index];
      if (url)
        frontier.enqueue(
          { url, title: source.title, kind: "page" },
          source,
          0,
          true,
        );
    }
  }

  async function visit(candidate: LightCrawlCandidate): Promise<void> {
    consultedSources.add(candidate.source.id);
    try {
      const { record, fromCache } = await readLightDocument({
        url: candidate.url,
        sourceId: candidate.source.id,
        session,
        config,
        cache,
      });
      successfulReads += 1;
      if (fromCache) cacheHits += 1;
      else {
        cacheMisses += 1;
        fetchedUrls.add(record.document.canonicalUrl);
      }
      records.set(record.document.canonicalUrl, record);
      for (const link of record.document.links) {
        frontier.enqueue(link, candidate.source, candidate.depth + 1);
      }
      for (const sitemap of session.sitemapsFor(
        new URL(candidate.url).origin,
      )) {
        frontier.enqueue(
          { url: sitemap, title: "", kind: "sitemap" },
          candidate.source,
          0,
        );
      }
    } catch (error) {
      if (isTerminalSearchError(error)) throw error;
      session.assertActive();
      if (failures.length < 8)
        failures.push(
          Object.freeze({
            url: candidate.url,
            errorCode: isWebPluginError(error)
              ? error.code
              : "web_response_invalid",
            error: isWebPluginError(error)
              ? error.message.slice(0, 256)
              : "The Light source could not be read.",
          }),
        );
    }
  }

  while (frontier.hasPending()) {
    session.assertActive();
    if (!session.canContinue()) break;
    const settled = await Promise.allSettled(frontier.nextBatch().map(visit));
    const rejected = settled.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  }
  session.assertActive();
  const finishedAt = Date.now();
  const currentRecords = [...records.values()].filter(
    (record) =>
      fetchedUrls.has(record.document.canonicalUrl) ||
      record.expiresAt > finishedAt,
  );
  return Object.freeze({
    successfulReads,
    records: Object.freeze(currentRecords) as readonly LightCachedDocument[],
    fetchedUrls,
    consultedSources: Object.freeze([...consultedSources]),
    failures: Object.freeze(failures),
    cacheHits,
    cacheMisses,
    candidatesDiscovered: frontier.discovered(),
    candidatesOmitted: frontier.omitted(),
  });
}
