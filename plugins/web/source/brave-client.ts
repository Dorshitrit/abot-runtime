import { boundText, sanitizeJsonText } from "../../../src/plugin-sdk/index.js";

import {
  WebPluginError,
  isWebPluginError,
  type WebPluginErrorCode,
} from "./errors.js";
import { WEB_LIMITS } from "./limits.js";
import { parsePublicHttpUrl } from "./network-policy.js";
import type { PublicHttpClient, PublicHttpResponse } from "./public-http.js";
import type { QueryResult, SearchHit } from "./search-types.js";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

type BraveWebResult = Readonly<{
  title?: unknown;
  url?: unknown;
  description?: unknown;
  snippet?: unknown;
}>;

export type BraveClient = Readonly<{
  searchOne(
    query: string,
    queryIndex: number,
    abortSignal: AbortSignal,
  ): Promise<QueryResult>;
}>;

function stringValue(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return boundText(sanitizeJsonText(value).trim(), {
    maxChars,
    marker: "...",
  }).text;
}

function responseHeader(response: PublicHttpResponse, name: string): string {
  const raw = response.headers[name];
  return (Array.isArray(raw) ? raw[0] : raw) ?? "";
}

function assertJsonResponse(response: PublicHttpResponse): void {
  const contentType = responseHeader(response, "content-type").toLowerCase();
  const contentEncoding = responseHeader(response, "content-encoding")
    .trim()
    .toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new WebPluginError(
      "web_search_response_invalid",
      "Brave Search returned an unsupported response encoding.",
    );
  }
  if (!contentType.includes("application/json")) {
    throw new WebPluginError(
      "web_search_response_invalid",
      "Brave Search returned a non-JSON response.",
    );
  }
  if (response.partialContent) {
    throw new WebPluginError(
      "web_search_response_invalid",
      "Brave Search returned an oversized response.",
    );
  }
}

function parseBraveHits(body: Uint8Array, query: string): readonly SearchHit[] {
  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: false }).decode(body),
    );
  } catch {
    throw new WebPluginError(
      "web_search_response_invalid",
      "Brave Search returned invalid JSON.",
    );
  }
  const web =
    payload && typeof payload === "object" && "web" in payload
      ? (payload as { web?: unknown }).web
      : undefined;
  const rawResults =
    web && typeof web === "object" && "results" in web
      ? (web as { results?: unknown }).results
      : undefined;
  if (rawResults !== undefined && !Array.isArray(rawResults)) {
    throw new WebPluginError(
      "web_search_response_invalid",
      "Brave Search returned an invalid result collection.",
    );
  }
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of (rawResults ?? []).entries()) {
    if (!raw || typeof raw !== "object") continue;
    const result = raw as BraveWebResult;
    const title = stringValue(result.title, WEB_LIMITS.upstreamTitleChars);
    const rawUrl = stringValue(result.url, WEB_LIMITS.searchResultUrlChars);
    if (!title || !rawUrl) continue;
    let parsed: URL;
    try {
      parsed = parsePublicHttpUrl(rawUrl);
    } catch {
      continue;
    }
    const url = parsed.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    hits.push(
      Object.freeze({
        query,
        title,
        url,
        domain: parsed.hostname.toLowerCase().replace(/^www\./u, ""),
        snippet: stringValue(
          result.description ?? result.snippet,
          WEB_LIMITS.upstreamSnippetChars,
        ),
        rank: index + 1,
      }),
    );
    if (hits.length >= WEB_LIMITS.searchResultsPerQuery) break;
  }
  return Object.freeze(hits);
}

function mapBraveStatus(status: number): WebPluginError {
  if (status === 401 || status === 403) {
    return new WebPluginError(
      "web_search_authentication_failed",
      "Brave Search rejected the configured API key.",
    );
  }
  if (status === 429) {
    return new WebPluginError(
      "web_search_rate_limited",
      "Brave Search rate-limited the request.",
    );
  }
  return new WebPluginError(
    "web_search_upstream_failed",
    `Brave Search returned HTTP ${status}.`,
  );
}

function isTerminalTransportError(code: WebPluginErrorCode): boolean {
  return code === "web_request_aborted" || code === "web_request_timed_out";
}

function delay(ms: number, abortSignal: AbortSignal): Promise<void> {
  if (abortSignal.aborted) {
    return Promise.reject(
      new WebPluginError("web_request_aborted", "The web request was aborted."),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      abortSignal.removeEventListener("abort", onAbort);
      operation();
    };
    const timeout = setTimeout(() => finish(resolve), ms);
    timeout.unref?.();
    const onAbort = () =>
      finish(() =>
        reject(
          new WebPluginError(
            "web_request_aborted",
            "The web request was aborted.",
          ),
        ),
      );
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createBraveClient(params: {
  apiKey: string;
  retryBaseMs: number;
  httpClient: PublicHttpClient;
}): BraveClient {
  const apiKey = params.apiKey.trim();
  return Object.freeze({
    async searchOne(query, queryIndex, abortSignal) {
      if (!apiKey) {
        throw new WebPluginError(
          "web_search_api_key_missing",
          "web_search requires BRAVE_SEARCH_API_KEY. Configure the environment variable and restart the runtime.",
        );
      }
      let lastError: WebPluginError | undefined;
      for (let attempt = 0; attempt <= WEB_LIMITS.retryAttempts; attempt += 1) {
        try {
          const url = new URL(BRAVE_ENDPOINT);
          url.searchParams.set("q", query);
          url.searchParams.set("count", "10");
          url.searchParams.set("safesearch", "moderate");
          const response = await params.httpClient.get({
            url: url.toString(),
            headers: Object.freeze({
              Accept: "application/json",
              "X-Subscription-Token": apiKey,
            }),
            maxBytes: WEB_LIMITS.responseBytes,
            maxRedirects: 0,
            timeoutMs: WEB_LIMITS.requestTimeoutMs,
            abortSignal,
          });
          if (response.status < 200 || response.status >= 300) {
            throw mapBraveStatus(response.status);
          }
          assertJsonResponse(response);
          return Object.freeze({
            query,
            hits: parseBraveHits(response.body, query),
          });
        } catch (error) {
          lastError = isWebPluginError(error)
            ? error
            : new WebPluginError(
                "web_search_upstream_failed",
                "Brave Search could not complete the request.",
              );
          if (isTerminalTransportError(lastError.code)) throw lastError;
          if (
            lastError.code !== "web_search_rate_limited" ||
            attempt >= WEB_LIMITS.retryAttempts
          ) {
            break;
          }
          await delay(
            params.retryBaseMs * (attempt + 1) + queryIndex * 100,
            abortSignal,
          );
        }
      }
      return Object.freeze({
        query,
        hits: Object.freeze([]),
        errorCode: lastError?.code ?? "web_search_upstream_failed",
        error:
          lastError?.message ?? "Brave Search could not complete the request.",
      });
    },
  });
}
