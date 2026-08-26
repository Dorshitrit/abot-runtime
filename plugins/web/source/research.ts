import { mapWithConcurrency } from "./concurrency.js";
import { isWebPluginError } from "./errors.js";
import type { WebFetchService } from "./fetch-service.js";
import { WEB_LIMITS } from "./limits.js";
import type {
  QueryResult,
  SearchCoverage,
  SearchHit,
  SourceFetch,
} from "./search-types.js";

export function uniqueHits(
  results: readonly QueryResult[],
): readonly SearchHit[] {
  const seen = new Set<string>();
  return Object.freeze(
    results
      .flatMap(({ hits }) => hits)
      .filter(({ url }) => {
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      }),
  );
}

export async function fetchSources(
  hits: readonly SearchHit[],
  fetchService: WebFetchService,
  abortSignal: AbortSignal,
): Promise<readonly SourceFetch[]> {
  const candidates = hits.slice(0, WEB_LIMITS.searchSourceFetches);
  const results: SourceFetch[] = [];
  for (
    let offset = 0;
    offset < candidates.length &&
    results.filter(({ page }) => !!page).length <
      WEB_LIMITS.targetReadableSources;
    offset += WEB_LIMITS.searchSourceConcurrency
  ) {
    const batch = candidates.slice(
      offset,
      offset + WEB_LIMITS.searchSourceConcurrency,
    );
    const fetched = await mapWithConcurrency(
      batch,
      WEB_LIMITS.searchSourceConcurrency,
      async (hit): Promise<SourceFetch> => {
        try {
          return Object.freeze({
            hit,
            page: await fetchService.fetchPage(hit.url, abortSignal),
          });
        } catch (error) {
          if (
            isWebPluginError(error) &&
            (error.code === "web_request_aborted" ||
              error.code === "web_request_timed_out")
          ) {
            throw error;
          }
          return Object.freeze({
            hit,
            errorCode: isWebPluginError(error)
              ? error.code
              : "web_response_invalid",
            error: isWebPluginError(error)
              ? error.message
              : "The source page could not be fetched.",
          });
        }
      },
    );
    results.push(...fetched);
  }
  return Object.freeze(results);
}

export function coverageFor(params: {
  results: readonly QueryResult[];
  hits: readonly SearchHit[];
  sourceFetches: readonly SourceFetch[];
  outputTruncated: boolean;
}): SearchCoverage {
  const pages = params.sourceFetches.flatMap(({ page }) =>
    page ? [page] : [],
  );
  const readableChars = pages.reduce((sum, page) => sum + page.text.length, 0);
  const uniqueDomains = new Set(params.hits.map(({ domain }) => domain)).size;
  const failedSourceFetches = params.sourceFetches.length - pages.length;
  const coverageStatus =
    params.hits.length === 0 || pages.length === 0
      ? "weak"
      : pages.length >= 3 && uniqueDomains >= 3 && readableChars >= 1_500
        ? "sufficient"
        : "partial";
  return Object.freeze({
    queriesRun: params.results.length,
    resultsFound: params.hits.length,
    uniqueDomains,
    sourceFetchesAttempted: params.sourceFetches.length,
    readableSources: pages.length,
    partialSources: pages.filter(({ partialContent }) => partialContent).length,
    failedSourceFetches,
    readableChars,
    coverageStatus,
    outputTruncated: params.outputTruncated,
  });
}
