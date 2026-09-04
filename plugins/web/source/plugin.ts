import {
  failureFromError,
  failureResult,
  readBoundedInteger,
  type RuntimePluginEntrypoint,
  type RuntimePluginLoadContext,
} from "../../../src/plugin-sdk/index.js";

import { isWebPluginError } from "./errors.js";
import { createWebFetchService } from "./fetch-service.js";
import { buildFetchPresentation } from "./fetch-presentation.js";
import { WEB_LIMITS } from "./limits.js";
import {
  parseFetchParams,
  parseSearchParams,
  webFetchCallAdapter,
  webSearchCallAdapter,
} from "./parameters.js";
import {
  createPublicHttpClient,
  type PublicHttpClient,
} from "./public-http.js";
import { selectWebSearchService } from "./search-service-selector.js";
import { projectLightSearchEventMeta } from "./light/search-metadata.js";
import { lightSearchFailureResult } from "./light/search-unavailable.js";
import { successWithSourceReceipts } from "./source-receipt-budget.js";

export type WebPluginDependencies = Readonly<{
  httpClient?: PublicHttpClient;
}>;

function failure(error: unknown, operation: string) {
  const lightFailure = lightSearchFailureResult(error);
  if (lightFailure) return lightFailure;
  if (isWebPluginError(error)) {
    return failureResult({
      errorCode: error.code,
      message: error.message,
      output: `${operation} failed: ${error.message}`,
    });
  }
  return failureFromError(error, {
    fallbackCode: `${operation}_failed`,
    fallbackMessage: `${operation} failed.`,
    operation,
  });
}

export function createWebPlugin(
  context: RuntimePluginLoadContext,
  dependencies: WebPluginDependencies = {},
): RuntimePluginEntrypoint {
  const httpClient = dependencies.httpClient ?? createPublicHttpClient();
  const fetchService = createWebFetchService(httpClient);
  const braveApiKey = context.secrets?.get("braveSearchApiKey")?.trim() ?? "";
  const retryBaseMs = readBoundedInteger(context.config?.retryBaseMs, {
    name: "retryBaseMs",
    minimum: 0,
    maximum: 10_000,
    defaultValue: WEB_LIMITS.retryBaseMs,
  });
  const searchService = selectWebSearchService({
    apiKey: braveApiKey,
    retryBaseMs,
    httpClient,
    fetchService,
    lightConfig: context.config?.light,
  });

  const handlers: RuntimePluginEntrypoint["handlers"] = {
    async web_fetch(params, executionContext) {
      try {
        const urls = parseFetchParams(params);
        const pages = await fetchService.fetchPages(
          urls,
          executionContext?.abortSignal,
        );
        const presentation = buildFetchPresentation(pages);
        return successWithSourceReceipts(
          {
            output: presentation.output,
            progress: true,
            producedNewInformation: true,
            data: {
              hasData: true,
              itemCount: pages.length,
              eventMeta: {
                urls: pages.map(({ finalUrl }) => finalUrl),
                partialUrls: pages
                  .filter(({ partialContent }) => partialContent)
                  .map(({ finalUrl }) => finalUrl),
              },
              observationMeta: {
                kind: "volatile_external",
                carryPolicy: "never",
              },
            },
          },
          { version: 1, operation: "fetch", sources: presentation.sources },
        );
      } catch (error) {
        return failure(error, "web_fetch");
      }
    },
    async web_search(params, executionContext) {
      try {
        const queries = parseSearchParams(params);
        const search = await searchService.search(
          queries,
          executionContext?.abortSignal,
        );
        return successWithSourceReceipts(
          {
            output: search.output,
            progress: search.hits.length > 0,
            producedNewInformation: search.hits.length > 0,
            data: {
              hasData: search.hits.length > 0,
              itemCount: search.hits.length,
              eventMeta: {
                query: queries[0],
                queries,
                urls: search.hits.map(({ url }) => url),
                fetchedUrls: search.sourceFetches.flatMap(({ page }) =>
                  page ? [page.finalUrl] : [],
                ),
                partialFetchedUrls: search.sourceFetches.flatMap(({ page }) =>
                  page?.partialContent ? [page.finalUrl] : [],
                ),
                sourceFetchErrors: search.sourceFetches.flatMap(
                  ({ hit, errorCode, error }) =>
                    error
                      ? [
                          {
                            url: hit.url,
                            errorCode,
                            error,
                          },
                        ]
                      : [],
                ),
                coverage: search.coverage,
                ...projectLightSearchEventMeta(search.lightSearch),
              },
              observationMeta: {
                kind: "volatile_external",
                carryPolicy: "never",
              },
            },
          },
          search.webSources,
        );
      } catch (error) {
        return failure(error, "web_search");
      }
    },
  };
  const adapters: NonNullable<RuntimePluginEntrypoint["adapters"]> = {
    web_fetch: webFetchCallAdapter,
    web_search: webSearchCallAdapter,
  };
  return Object.freeze({ handlers, adapters });
}
