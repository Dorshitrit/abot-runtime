import { afterEach, describe, expect, test, vi } from "vitest";

import { createWebPlugin } from "../../../../plugins/web/source/plugin.js";
import { createLightSearchService } from "../../../../plugins/web/source/light/search-service.js";
import { selectLightSources } from "../../../../plugins/web/source/light/sources/source-selection.js";
import { article, feed, fixtureContext, fixtureHttp, fixtureResponse, fixtureSource } from "./search-fixture.js";

afterEach(() => vi.restoreAllMocks());

describe("Light result failure, scope, and output contracts", () => {
  test("retains structured source failures in the plugin failure envelope", async () => {
    const sources = [fixtureSource("failed-one", "astronomy"), fixtureSource("failed-two", "astronomy")];
    const fixture = fixtureHttp(({ url }) => fixtureResponse(url, "Temporarily unavailable", { status: 503 }));
    const plugin = createWebPlugin(fixtureContext({ sources, sourceLimit: 2 }), fixture);

    const result = await plugin.handlers.web_search!({ query: "astronomy" });

    expect(result).toMatchObject({
      ok: false, errorCode: "web_search_sources_unavailable", producedNewInformation: false,
      data: {
        hasData: false, itemCount: 0,
        eventMeta: {
          lightSearch: {
            kind: "web_search_scope", version: 1, provider: "light", scope: "configured_sources",
            selectedSources: sources.map(({ id }) => id), consultedSources: sources.map(({ id }) => id),
            sources: [], stopReason: "completed",
            sourceErrors: sources.map(({ entryUrls }) => ({ url: entryUrls[0], errorCode: "web_fetch_http_error", error: expect.any(String) })),
          },
        },
        observationMeta: { kind: "volatile_external", carryPolicy: "never" },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(128 * 1024);
  });

  test.each(["request_budget", "time_budget"] as const)("returns bounded empty evidence when %s expires after robots", async (stopReason) => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const source = fixtureSource("bounded", "astronomy");
    const fixture = fixtureHttp(() => { throw new Error("The page must not be requested after its crawl budget expires"); });
    const httpClient = {
      async get(request: Parameters<typeof fixture.httpClient.get>[0]) {
        const response = await fixture.httpClient.get(request);
        if (stopReason === "time_budget") now += 11;
        return response;
      },
    };
    const plugin = createWebPlugin(fixtureContext({
      sources: [source], maxRequests: stopReason === "request_budget" ? 1 : 24,
      softTimeoutMs: 10, hardTimeoutMs: 1_000,
    }), { httpClient });

    const result = await plugin.handlers.web_search!({ query: "astronomy" });

    expect(result).toMatchObject({
      ok: true, producedNewInformation: false,
      data: { hasData: false, itemCount: 0, eventMeta: {
        urls: [], lightSearch: { provider: "light", stopReason, sources: [], requests: 1 },
      } },
    });
    expect(fixture.requests.map(({ url }) => url)).toEqual(["https://bounded.example/robots.txt"]);
  });

  test("attributes a fresh cached result when this query selects a different live source", async () => {
    const cached = { ...fixtureSource("archive", "alpha"), entryUrls: ["https://archive.example/article"] };
    const current = { ...fixtureSource("current", "beta"), entryUrls: ["https://current.example/article"] };
    const sources = [cached, current];
    const fixture = fixtureHttp(({ url }) => fixtureResponse(url,
      url === cached.entryUrls[0]
        ? article("Alpha beta observation", "Alpha beta evidence from the archived observation.")
        : article("Gardening", "Current gardening advice without the requested observation.")));
    const service = createLightSearchService({ httpClient: fixture.httpClient, config: { sources, sourceLimit: 1 } });

    const first = await service.search(["alpha"]);
    expect(first.hits.map(({ url }) => url)).toEqual([cached.entryUrls[0]]);
    expect(selectLightSources(["beta"], sources, 1).map(({ id }) => id)).toEqual([current.id]);
    const previousRequests = fixture.requests.length;
    const second = await service.search(["beta"]);

    expect(second.hits.map(({ url }) => url)).toEqual([cached.entryUrls[0]]);
    expect(second.lightSearch?.selectedSources).toEqual([current.id, cached.id]);
    expect(second.lightSearch?.consultedSources).toEqual([current.id, cached.id]);
    expect(second.lightSearch?.sources).toEqual([{
      url: cached.entryUrls[0], cacheState: "fresh_cache", fetchedAt: first.lightSearch?.sources[0]?.fetchedAt,
    }]);
    expect(fixture.requests.slice(previousRequests).map(({ url }) => new URL(url).origin)).toEqual([
      "https://current.example", "https://current.example",
    ]);
  });

  test("keeps 25 long-URL multilingual hits and provenance inside the plugin envelope", async () => {
    const queries = ["alpha", "bravo", "charlie", "delta", "echo"];
    const source = { ...fixtureSource("large-results", "alpha"), keywords: queries };
    const entries = queries.flatMap((query) => Array.from({ length: 5 }, (_, index) => {
      const prefix = `${source.allowedOrigins[0]}/${query}-${index}-`;
      return { query, title: query, url: prefix + "x".repeat(1_024 - prefix.length) };
    }));
    const byUrl = new Map(entries.map((entry) => [entry.url, entry]));
    const fixture = fixtureHttp(({ url }) => {
      if (url === source.entryUrls[0]) return fixtureResponse(url, feed(entries), { contentType: "application/rss+xml" });
      const entry = byUrl.get(url);
      if (!entry) throw new Error(`Unexpected candidate ${url}`);
      const title = `${entry.query} ${"א".repeat(90)}${"🧪".repeat(25)}`;
      const text = `${entry.query} ${"טקסט בעברית ובאנגלית 🧪 ".repeat(1_500)}`;
      return fixtureResponse(url, article(title, text));
    });
    const plugin = createWebPlugin(fixtureContext({ sources: [source], sourceLimit: 1, maxRequests: 40 }), fixture);

    const result = await plugin.handlers.web_search!({ queries });

    expect(result).toMatchObject({ ok: true, producedNewInformation: true, data: { itemCount: 25 } });
    const eventMeta = result.data?.eventMeta as {
      urls: string[]; fetchedUrls: string[]; lightSearch: { sources: { url: string }[] };
    };
    expect(eventMeta.urls).toHaveLength(25);
    expect(eventMeta.urls.every((url) => url.length === 1_024)).toBe(true);
    expect(eventMeta.lightSearch.sources.map(({ url }) => url)).toEqual(eventMeta.urls);
    expect(eventMeta.fetchedUrls.length).toBeLessThanOrEqual(6);
    expect(Buffer.byteLength(result.output ?? "", "utf8")).toBeLessThanOrEqual(48 * 1024);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(128 * 1024);
  });
});
