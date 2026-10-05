import { afterEach, describe, expect, it, vi } from "vitest";
import { WebPluginError } from "../../../plugins/web/source/errors.js";
import { WEB_LIMITS } from "../../../plugins/web/source/limits.js";
import { createWebPlugin } from "../../../plugins/web/source/plugin.js";
import type { PublicHttpRequest, PublicHttpResponse } from "../../../plugins/web/source/public-http.js";
import { article, fixtureContext, fixtureHttp, fixtureResponse } from "./web-light-search/search-fixture.js";

const urls = ["https://slow.example/article", "https://one.example/article", "https://two.example/article", "https://three.example/article"];
const timeout = () => new WebPluginError("web_request_timed_out", "The upstream web request timed out.");
const context = () => ({ ...fixtureContext(undefined), secrets: { get: () => "fixture-brave-key" } });

function searchResponse(request: PublicHttpRequest, sources: readonly string[]) {
  return fixtureResponse(request.url, JSON.stringify({ web: { results: sources.map((url, index) => ({
    title: `Search result ${index + 1}`, url, description: `Observed search snippet ${index + 1}`,
  })) } }), { contentType: "application/json" });
}

function searchFixture(
  sources: readonly string[],
  fetchSource: (request: PublicHttpRequest) => PublicHttpResponse | Promise<PublicHttpResponse>,
) {
  const fixture = fixtureHttp((request) => new URL(request.url).hostname === "api.search.brave.com"
    ? searchResponse(request, sources) : fetchSource(request));
  return { ...fixture, plugin: createWebPlugin(context(), fixture) };
}

afterEach(() => vi.useRealTimers());

describe("Brave search source timeout isolation", () => {
  it("preserves hits and readable sources when one optional page times out", async () => {
    const fixture = searchFixture(urls, (request) => {
      if (request.url === urls[0]) throw timeout();
      return fixtureResponse(request.url, article("Page title", `Readable evidence from ${new URL(request.url).hostname}`));
    });
    const result = await fixture.plugin.handlers.web_search!({ query: "requested evidence" });
    expect(result).toMatchObject({ ok: true, producedNewInformation: true, data: {
      itemCount: 4, eventMeta: {
        queries: ["requested evidence"], urls,
        fetchedUrls: urls.slice(1),
        sourceFetchErrors: [{ url: urls[0], errorCode: "web_request_timed_out" }],
        coverage: { resultsFound: 4, sourceFetchesAttempted: 4, readableSources: 3, failedSourceFetches: 1 },
        webSources: { provider: "brave", sources: [
          { url: urls[0], retrieval: "failed", presentation: "snippet" },
          ...urls.slice(1).map((url) => ({ url, retrieval: "retrieved", presentation: "content" })),
        ] },
      },
    } });
    expect(result.output).toContain("Observed search snippet 1");
    expect(result.output).toContain("Readable evidence from three.example");
    expect(result.output).toContain("Source fetch failed: The upstream web request timed out.");
    expect(fixture.requests.map(({ url }) => url).slice(1)).toEqual(urls);
    expect(fixture.requests).toHaveLength(5);
    expect(fixture.requests.every(({ timeoutMs }) => timeoutMs === WEB_LIMITS.requestTimeoutMs)).toBe(true);
  });

  it("reports weak coverage and failed-source receipts when every optional page times out", async () => {
    const fixture = searchFixture(urls.slice(0, 2), () => { throw timeout(); });
    const result = await fixture.plugin.handlers.web_search!({ query: "requested evidence" });
    expect(result).toMatchObject({ ok: true, producedNewInformation: true, data: { itemCount: 2,
      eventMeta: { fetchedUrls: [], sourceFetchErrors: urls.slice(0, 2).map((url) => ({
        url, errorCode: "web_request_timed_out",
      })), coverage: { coverageStatus: "weak", resultsFound: 2, readableSources: 0, failedSourceFetches: 2 },
      webSources: { provider: "brave", sources: urls.slice(0, 2).map((url) => ({
        url, retrieval: "failed", presentation: "snippet",
      })) } },
    } });
    expect(result.output).toContain("Observed search snippet 1");
    expect(result.output).toContain("Observed search snippet 2");
    expect(fixture.requests).toHaveLength(3);
  });

  it("keeps caller cancellation fatal after the search API already returned hits", async () => {
    const controller = new AbortController();
    const fixture = searchFixture([urls[0]!], (request) => {
      controller.abort();
      expect(request.abortSignal?.aborted).toBe(true);
      throw new WebPluginError("web_request_aborted", "The web request was aborted.");
    });
    const result = await fixture.plugin.handlers.web_search!({ query: "requested evidence" }, { abortSignal: controller.signal });
    expect(result).toMatchObject({ ok: false, errorCode: "web_request_aborted", interruption: "aborted" });
    expect(result.data?.eventMeta).toBeUndefined();
    expect(fixture.requests).toHaveLength(2);
  });

  it("keeps the whole-search deadline fatal while source retrieval is pending", async () => {
    vi.useFakeTimers();
    let announceSource!: () => void;
    const sourceStarted = new Promise<void>((resolve) => { announceSource = resolve; });
    const fixture = searchFixture([urls[0]!], (request) => new Promise((_resolve, reject) => {
      announceSource();
      request.abortSignal!.addEventListener("abort", () => reject(
        new WebPluginError("web_request_aborted", "The web request was aborted."),
      ), { once: true });
    }));
    const pending = fixture.plugin.handlers.web_search!({ query: "requested evidence" });
    await sourceStarted;
    await vi.advanceTimersByTimeAsync(WEB_LIMITS.searchTotalTimeoutMs);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, errorCode: "web_request_timed_out",
      output: "web_search failed: The web search exceeded its total time limit." });
    expect(result).not.toHaveProperty("interruption");
    expect(result.data?.eventMeta).toBeUndefined();
    expect(fixture.requests).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still fails when the Brave API itself times out, without retry or fallback", async () => {
    const fixture = fixtureHttp(() => { throw timeout(); });
    const result = await createWebPlugin(context(), fixture).handlers.web_search!({ query: "requested evidence" });
    expect(result).toMatchObject({ ok: false, errorCode: "web_request_timed_out" });
    expect(result.data?.eventMeta).toBeUndefined();
    expect(fixture.requests).toHaveLength(1);
    expect(new URL(fixture.requests[0]!.url).hostname).toBe("api.search.brave.com");
  });

  it("preserves direct web_fetch timeout failure semantics", async () => {
    const fixture = fixtureHttp(() => { throw timeout(); });
    const result = await createWebPlugin(context(), fixture).handlers.web_fetch!({ url: urls[0] });
    expect(result).toMatchObject({ ok: false, errorCode: "web_request_timed_out" });
    expect(result.data?.eventMeta).toBeUndefined();
    expect(fixture.requests).toHaveLength(1);
  });

  it.each([
    { code: "web_request_aborted", stopped: true, interrupted: true },
    { code: "web_request_aborted", stopped: false, interrupted: false },
    { code: "web_request_timed_out", stopped: true, interrupted: false },
    { code: "web_response_invalid", stopped: true, interrupted: false },
  ] as const)("marks only caller aborts on direct fetch: $code, stopped=$stopped", async (expected) => {
    const controller = new AbortController();
    const fixture = fixtureHttp(() => {
      if (expected.stopped) controller.abort();
      throw new WebPluginError(expected.code, "Bounded transport failure");
    });
    const result = await createWebPlugin(context(), fixture).handlers.web_fetch!(
      { url: urls[0] }, { abortSignal: controller.signal });
    expect(result).toMatchObject({ ok: false, errorCode: expected.code });
    expect(result.interruption).toBe(expected.interrupted ? "aborted" : undefined);
  });
});
