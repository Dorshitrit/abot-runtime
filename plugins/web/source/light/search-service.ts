import type { PublicHttpClient } from "../public-http.js";
import { coverageFor } from "../research.js";
import { buildSearchPresentation } from "../search-presentation.js";
import type { SearchExecution } from "../search-types.js";
import { readLightConfig } from "./config.js";
import { createLightTransport } from "./crawl/transport.js";
import { createDocumentCache } from "./documents/document-cache.js";
import { rankLightDocuments } from "./ranking/document-ranking.js";
import { collectLightDocuments } from "./search-collection.js";
import type { LightSearchMetadata } from "./search-metadata.js";
import { selectLightSources } from "./sources/source-selection.js";
import { LightSearchUnavailableError } from "./search-unavailable.js";

function createInitializedLightService(
  httpClient: PublicHttpClient,
  rawConfig: unknown,
) {
  const config = readLightConfig(rawConfig);
  const transport = createLightTransport({ httpClient, config });
  const cache = createDocumentCache(config);
  return Object.freeze({
    async search(
      queries: readonly string[],
      abortSignal?: AbortSignal,
    ): Promise<SearchExecution> {
      const session = transport.createSession(abortSignal);
      try {
        const selected = selectLightSources(
          queries,
          config.sources,
          config.sourceLimit,
        );
        const collection = await collectLightDocuments({
          queries,
          sources: selected,
          config,
          session,
          cache,
        });
        session.assertActive();
        const ranked = rankLightDocuments(queries, collection.records);
        const recordsByUrl = new Map(
          collection.records.map((record) => [
            record.document.canonicalUrl,
            record,
          ]),
        );
        const resultSourceIds = ranked.hits.map(
          ({ url }) => recordsByUrl.get(url)!.sourceId,
        );
        const snapshot = session.snapshot();
        const lightSearch: LightSearchMetadata = Object.freeze({
          kind: "web_search_scope",
          version: 1,
          provider: "light",
          scope: "configured_sources",
          sourceSetId: config.sourceSetId,
          sourceSetVersion: config.sourceSetVersion,
          selectedSources: Object.freeze([
            ...new Set([...selected.map(({ id }) => id), ...resultSourceIds]),
          ]),
          consultedSources: Object.freeze([
            ...new Set([...collection.consultedSources, ...resultSourceIds]),
          ]),
          stopReason:
            snapshot.stopReason ??
            (collection.candidatesOmitted ? "candidate_budget" : "completed"),
          requests: snapshot.requests,
          bytes: snapshot.bytes,
          decodedBytes: snapshot.decodedBytes,
          candidatesDiscovered: collection.candidatesDiscovered,
          candidatesOmitted: collection.candidatesOmitted,
          cache: Object.freeze({
            mode: "memory",
            hits: collection.cacheHits,
            misses: collection.cacheMisses,
            staleServed: 0,
          }),
          sources: Object.freeze(
            ranked.hits.map(({ url }) => {
              const record = recordsByUrl.get(url)!;
              return Object.freeze({
                url,
                fetchedAt: record.fetchedAt,
                cacheState: collection.fetchedUrls.has(url)
                  ? ("fetched" as const)
                  : ("fresh_cache" as const),
                ...(record.document.publishedAt
                  ? { publishedAt: record.document.publishedAt }
                  : {}),
                ...(record.document.updatedAt
                  ? { updatedAt: record.document.updatedAt }
                  : {}),
              });
            }),
          ),
          sourceErrors: collection.failures,
        });
        const hasSourceFailure = collection.failures.some(
          ({ errorCode }) => errorCode !== "web_search_budget_exhausted",
        );
        const noUsableSources =
          collection.successfulReads === 0 && ranked.hits.length === 0;
        if (noUsableSources && hasSourceFailure && !snapshot.stopReason)
          throw new LightSearchUnavailableError(lightSearch);
        const presentation = buildSearchPresentation({
          results: ranked.results,
          sourceFetches: ranked.sourceFetches,
          sourceRetrievals: ranked.hits.map((hit) => ({
            hit,
            page: recordsByUrl.get(hit.url)?.page,
          })),
          coverage: coverageFor({ ...ranked, outputTruncated: false }),
          lightSearch,
        });
        session.assertActive();
        return Object.freeze({
          queries: Object.freeze([...queries]),
          ...ranked,
          coverage: presentation.coverage,
          output: presentation.output,
          webSources: Object.freeze({
            version: 1,
            operation: "search",
            provider: "light",
            sources: presentation.sources,
          }),
          lightSearch,
        });
      } finally {
        session.dispose();
      }
    },
  });
}

export function createLightSearchService(params: {
  httpClient: PublicHttpClient;
  config?: unknown;
}) {
  let service: ReturnType<typeof createInitializedLightService> | undefined;
  return Object.freeze({
    search(
      queries: readonly string[],
      abortSignal?: AbortSignal,
    ): Promise<SearchExecution> {
      service ??= createInitializedLightService(
        params.httpClient,
        params.config,
      );
      return service.search(queries, abortSignal);
    },
  });
}
