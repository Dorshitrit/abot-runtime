import { mapWithConcurrency } from "./concurrency.js";
import { createBraveClient } from "./brave-client.js";
import { WebPluginError } from "./errors.js";
import type { WebFetchService } from "./fetch-service.js";
import { WEB_LIMITS } from "./limits.js";
import type { PublicHttpClient } from "./public-http.js";
import { fetchSources, coverageFor, uniqueHits } from "./research.js";
import { buildSearchPresentation } from "./search-presentation.js";
import type { SearchExecution } from "./search-types.js";

export type BraveSearchService = Readonly<{
  search(
    queries: readonly string[],
    abortSignal?: AbortSignal,
  ): Promise<SearchExecution>;
}>;

function createSearchDeadline(abortSignal?: AbortSignal): Readonly<{
  signal: AbortSignal;
  expired: () => boolean;
  dispose: () => void;
}> {
  const controller = new AbortController();
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    controller.abort();
  }, WEB_LIMITS.searchTotalTimeoutMs);
  timeout.unref?.();
  const onAbort = () => controller.abort();
  if (abortSignal?.aborted) {
    controller.abort();
  } else {
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  }
  return Object.freeze({
    signal: controller.signal,
    expired: () => expired,
    dispose: () => {
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", onAbort);
    },
  });
}

function assertSearchActive(
  deadline: Readonly<{
    signal: AbortSignal;
    expired: () => boolean;
  }>,
): void {
  if (deadline.expired()) {
    throw new WebPluginError(
      "web_request_timed_out",
      "The web search exceeded its total time limit.",
    );
  }
  if (deadline.signal.aborted) {
    throw new WebPluginError(
      "web_request_aborted",
      "The web request was aborted.",
    );
  }
}

export function createBraveSearchService(params: {
  apiKey: string;
  retryBaseMs: number;
  httpClient: PublicHttpClient;
  fetchService: WebFetchService;
}): BraveSearchService {
  const braveClient = createBraveClient({
    apiKey: params.apiKey,
    retryBaseMs: params.retryBaseMs,
    httpClient: params.httpClient,
  });
  return Object.freeze({
    async search(queries, abortSignal) {
      if (!params.apiKey.trim()) {
        throw new WebPluginError(
          "web_search_api_key_missing",
          "web_search requires BRAVE_SEARCH_API_KEY. Configure the environment variable and restart the runtime.",
        );
      }
      const deadline = createSearchDeadline(abortSignal);
      try {
        const results = await mapWithConcurrency(
          queries,
          WEB_LIMITS.searchQueryConcurrency,
          (query, queryIndex) =>
            braveClient.searchOne(query, queryIndex, deadline.signal),
        );
        assertSearchActive(deadline);
        const hits = uniqueHits(results);
        const firstError = results.find(({ errorCode }) => !!errorCode);
        if (hits.length === 0 && firstError?.errorCode) {
          throw new WebPluginError(
            firstError.errorCode,
            firstError.error ?? "Brave Search could not complete the request.",
          );
        }
        const sourceFetches = await fetchSources(
          hits,
          params.fetchService,
          deadline.signal,
        );
        assertSearchActive(deadline);
        const presentation = buildSearchPresentation({
          results,
          sourceFetches,
          coverage: coverageFor({
            results,
            hits,
            sourceFetches,
            outputTruncated: false,
          }),
        });
        return Object.freeze({
          queries: Object.freeze([...queries]),
          results,
          sourceFetches,
          hits,
          coverage: presentation.coverage,
          output: presentation.output,
          webSources: Object.freeze({
            version: 1,
            operation: "search",
            provider: "brave",
            sources: presentation.sources,
          }),
        });
      } catch (error) {
        if (deadline.expired()) {
          throw new WebPluginError(
            "web_request_timed_out",
            "The web search exceeded its total time limit.",
          );
        }
        throw error;
      } finally {
        deadline.dispose();
      }
    },
  });
}
