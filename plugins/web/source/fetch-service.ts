import { mapWithConcurrency } from "./concurrency.js";
import { extractFetchedPage, type FetchedPage } from "./content.js";
import { WebPluginError } from "./errors.js";
import { WEB_LIMITS } from "./limits.js";
import { buildFetchPresentation } from "./fetch-presentation.js";
import type { PublicHttpClient } from "./public-http.js";

const PAGE_HEADERS = Object.freeze({
  Accept:
    "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,application/xml;q=0.8,text/xml;q=0.8",
});

export type WebFetchService = Readonly<{
  fetchPage(url: string, abortSignal?: AbortSignal): Promise<FetchedPage>;
  fetchPages(
    urls: readonly string[],
    abortSignal?: AbortSignal,
  ): Promise<readonly FetchedPage[]>;
}>;

export function createWebFetchService(
  httpClient: PublicHttpClient,
): WebFetchService {
  const fetchPage = async (url: string, abortSignal?: AbortSignal) => {
    const response = await httpClient.get({
      url,
      headers: PAGE_HEADERS,
      maxBytes: WEB_LIMITS.responseBytes,
      maxRedirects: WEB_LIMITS.redirects,
      timeoutMs: WEB_LIMITS.requestTimeoutMs,
      ...(abortSignal ? { abortSignal } : {}),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new WebPluginError(
        "web_fetch_http_error",
        `The public web server returned HTTP ${response.status}.`,
      );
    }
    return extractFetchedPage(response);
  };
  return Object.freeze({
    fetchPage,
    fetchPages: (urls, abortSignal) =>
      mapWithConcurrency(urls, WEB_LIMITS.fetchConcurrency, (url) =>
        fetchPage(url, abortSignal),
      ),
  });
}

export function formatFetchedPages(pages: readonly FetchedPage[]): string {
  return buildFetchPresentation(pages).output;
}
