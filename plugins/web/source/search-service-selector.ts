import type { WebFetchService } from "./fetch-service.js";
import { createLightSearchService } from "./light/search-service.js";
import type { PublicHttpClient } from "./public-http.js";
import { createBraveSearchService } from "./search-service.js";
import type { SearchExecution } from "./search-types.js";

export type WebSearchService = Readonly<{
  search(
    queries: readonly string[],
    abortSignal?: AbortSignal,
  ): Promise<SearchExecution>;
}>;

function hasConfiguredBraveKey(apiKey: string): boolean {
  return apiKey.trim().length > 0;
}

export function selectWebSearchService(params: {
  apiKey: string;
  retryBaseMs: number;
  httpClient: PublicHttpClient;
  fetchService: WebFetchService;
  lightConfig?: unknown;
}): WebSearchService {
  if (hasConfiguredBraveKey(params.apiKey))
    return createBraveSearchService(params);
  return createLightSearchService({
    httpClient: params.httpClient,
    config: params.lightConfig,
  });
}
