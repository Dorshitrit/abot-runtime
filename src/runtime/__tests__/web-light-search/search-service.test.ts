import { afterEach, describe, expect, test, vi } from "vitest";

import { createWebPlugin } from "../../../../plugins/web/source/plugin.js";
import { createLightSearchService } from "../../../../plugins/web/source/light/search-service.js";
import { LIGHT_SOURCE_SET_ID } from "../../../../plugins/web/source/light/sources/catalog.js";
import { WebPluginError } from "../../../../plugins/web/source/errors.js";
import {
  article,
  feed,
  fixtureContext,
  fixtureHttp,
  fixtureResponse,
  fixtureSource,
} from "./search-fixture.js";

afterEach(() => vi.restoreAllMocks());

describe("Light search service evidence and bounded crawling", () => {
  test("discovers article URLs through origin feed content from an empty cache", async () => {
    const source = fixtureSource("publisher", "astronomy");
    const discoveredUrl = "https://publisher.example/observatory-release";
    const fixture = fixtureHttp(({ url }) => {
      if (url === source.entryUrls[0])
        return fixtureResponse(
          url,
          feed([{ title: "Astronomy observation", url: discoveredUrl }]),
          { contentType: "application/rss+xml" },
        );
      if (url === discoveredUrl)
        return fixtureResponse(
          url,
          article(
            "Astronomy observation",
            "Astronomy telescope evidence from a fetched article.",
          ),
        );
      throw new Error(`Unexpected request: ${url}`);
    });
    const plugin = createWebPlugin(
      fixtureContext({ sources: [source] }),
      fixture,
    );
    const result = await plugin.handlers.web_search!({
      query: "astronomy observation",
    });
    expect(result).toMatchObject({
      ok: true,
      producedNewInformation: true,
      data: {
        hasData: true,
        itemCount: 1,
        eventMeta: {
          urls: [discoveredUrl],
          fetchedUrls: [discoveredUrl],
          lightSearch: {
            provider: "light",
            scope: "configured_sources",
            cache: { hits: 0, misses: 2 },
          },
        },
        observationMeta: { kind: "volatile_external", carryPolicy: "never" },
      },
    });
    expect(fixture.requests.map(({ url }) => url)).toEqual([
      "https://publisher.example/robots.txt",
      source.entryUrls[0],
      discoveredUrl,
    ]);
    expect(source.entryUrls).not.toContain(discoveredUrl);
    expect(result.output).toContain("Astronomy telescope evidence");
  });

  test.each([256, 4])(
    "gives both queries an article opportunity with candidate limit %i and a shared request budget",
    async (maxCandidates) => {
      const sources = [
        fixtureSource("first", "alpha"),
        fixtureSource("second", "beta"),
      ];
      const fixture = fixtureHttp(({ url }) => {
        const parsed = new URL(url);
        const keyword = parsed.hostname === "first.example" ? "alpha" : "beta";
        if (parsed.pathname === "/feed.xml")
          return fixtureResponse(
            url,
            feed(
              [1, 2, 3].map((index) => ({
                title: keyword,
                url: `${parsed.origin}/article-${index}`,
              })),
            ),
            { contentType: "application/rss+xml" },
          );
        return fixtureResponse(
          url,
          article(keyword, `Independent evidence for ${keyword}.`),
        );
      });
      const service = createLightSearchService({
        httpClient: fixture.httpClient,
        config: {
          sources,
          sourceLimit: 2,
          maxConcurrency: 1,
          maxRequests: 6,
          maxCandidates,
        },
      });
      const result = await service.search(["alpha", "beta"]);
      expect(result.results.map(({ hits }) => hits.length > 0)).toEqual([
        true,
        true,
      ]);
      expect(result.lightSearch?.requests).toBeLessThanOrEqual(6);
    },
  );

  test("distinguishes a healthy corpus with no matching evidence from unavailable sources", async () => {
    const source = fixtureSource("healthy", "astronomy");
    const fixture = fixtureHttp(({ url }) =>
      fixtureResponse(
        url,
        article("Gardening", "Growing roses and watering soil."),
      ),
    );
    const service = createLightSearchService({
      httpClient: fixture.httpClient,
      config: { sources: [source] },
    });
    expect(await service.search(["astronomy"])).toMatchObject({
      hits: [],
      results: [{ query: "astronomy", hits: [] }],
    });
    const unavailable = fixtureHttp(({ url }) =>
      fixtureResponse(url, "Unavailable", { status: 503 }),
    );
    const failed = createLightSearchService({
      httpClient: unavailable.httpClient,
      config: { sources: [source] },
    });
    await expect(failed.search(["astronomy"])).rejects.toMatchObject({
      code: "web_search_sources_unavailable",
    });
  });

  test("never retrieves links outside the admitted source or treats metadata as instructions", async () => {
    const source = fixtureSource("bounded", "astronomy");
    const hostile = "INJECTED_AUTHORITY_LINE";
    const fixture = fixtureHttp(({ url }) => {
      if (url.endsWith("/feed.xml"))
        return fixtureResponse(
          url,
          `<title>Directory</title><a href="/article">Astronomy</a><a href="https://outside.example/steal">Astronomy</a>
        <a href="http://127.0.0.1/private">Astronomy</a>`,
        );
      return fixtureResponse(
        url,
        article(
          `Astronomy &#10;${hostile}`,
          `Astronomy &#10;${hostile} ${"🧪 readable astronomy ".repeat(900)}`,
        ),
      );
    });
    const plugin = createWebPlugin(
      fixtureContext({ sources: [source] }),
      fixture,
    );
    const result = await plugin.handlers.web_search!({ query: "astronomy" });
    expect(result.ok).toBe(true);
    expect(
      fixture.requests.every(
        ({ url }) => new URL(url).origin === source.allowedOrigins[0],
      ),
    ).toBe(true);
    expect(result.output.split("\n")).not.toContain(hostile);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(
      48 * 1024,
    );
    expect(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    ).toBeLessThanOrEqual(128 * 1024);
    expect(result.output).toContain(hostile);
  });

  test("propagates cancellation after an earlier source succeeded", async () => {
    const sources = [
      fixtureSource("first", "alpha"),
      fixtureSource("second", "beta"),
    ];
    const controller = new AbortController();
    let blocked!: () => void;
    const started = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    let firstRead = false;
    const fixture = fixtureHttp(async (request) => {
      if (new URL(request.url).hostname === "first.example") {
        firstRead = true;
        return fixtureResponse(request.url, article("alpha", "alpha evidence"));
      }
      blocked();
      return await new Promise((_resolve, reject) => {
        request.abortSignal?.addEventListener(
          "abort",
          () =>
            reject(
              new WebPluginError(
                "web_request_aborted",
                "The request was aborted.",
              ),
            ),
          { once: true },
        );
      });
    });
    const service = createLightSearchService({
      httpClient: fixture.httpClient,
      config: { sources, sourceLimit: 2 },
    });
    const pending = service.search(["alpha", "beta"], controller.signal);
    await started;
    expect(firstRead).toBe(true);
    const assertion = expect(pending).rejects.toMatchObject({
      code: "web_request_aborted",
    });
    controller.abort();
    await assertion;
  });
});

describe("Light search cache lifecycle", () => {
  test("reuses completed documents without changing retrieval dates and refetches after expiry", async () => {
    let now = Date.UTC(2026, 2, 1);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const source = {
      ...fixtureSource("cached", "astronomy"),
      entryUrls: ["https://cached.example/article"],
    };
    const fixture = fixtureHttp(({ url }) =>
      fixtureResponse(url, article("Astronomy", "Astronomy observed source.")),
    );
    const service = createLightSearchService({
      httpClient: fixture.httpClient,
      config: { sources: [source], pageTtlMs: 1_000 },
    });
    const first = await service.search(["astronomy"]);
    expect(first.lightSearch?.sourceSetId).not.toBe(LIGHT_SOURCE_SET_ID);
    expect(first.lightSearch?.sourceSetId).toEqual(expect.any(String));
    now += 500;
    const second = await service.search(["astronomy"]);
    expect(second.lightSearch?.cache).toMatchObject({
      hits: 1,
      misses: 0,
      staleServed: 0,
    });
    expect(second.lightSearch?.sources[0]?.fetchedAt).toBe(
      first.lightSearch?.sources[0]?.fetchedAt,
    );
    now += 501;
    const third = await service.search(["astronomy"]);
    expect(third.lightSearch?.cache).toMatchObject({
      hits: 0,
      misses: 1,
      staleServed: 0,
    });
    expect(third.lightSearch?.sources[0]?.fetchedAt).not.toBe(
      first.lightSearch?.sources[0]?.fetchedAt,
    );
    expect(
      fixture.requests.filter(({ url }) => url.endsWith("/article")),
    ).toHaveLength(2);
  });

  test("honors no-store responses across independent searches", async () => {
    const source = {
      ...fixtureSource("uncached", "astronomy"),
      entryUrls: ["https://uncached.example/article"],
    };
    const fixture = fixtureHttp(({ url }) =>
      fixtureResponse(url, article("Astronomy", "Astronomy live source."), {
        headers: { "cache-control": "no-store" },
      }),
    );
    const service = createLightSearchService({
      httpClient: fixture.httpClient,
      config: { sources: [source] },
    });
    await service.search(["astronomy"]);
    const second = await service.search(["astronomy"]);
    expect(second.lightSearch?.cache).toMatchObject({ hits: 0, misses: 1 });
    expect(
      fixture.requests.filter(({ url }) => url.endsWith("/article")),
    ).toHaveLength(2);
  });
});
