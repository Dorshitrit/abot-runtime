import { describe, expect, test } from "vitest";

import { createWebPlugin } from "../../../../plugins/web/source/plugin.js";
import type { WebSourcesReceipt } from "../../../../plugins/web/source/source-receipt-contract.js";
import {
  article,
  feed,
  fixtureContext,
  fixtureHttp,
  fixtureResponse,
  fixtureSource,
} from "../web-light-search/search-fixture.js";

describe("web source receipt envelopes", () => {
  test("keeps maximum Brave result URLs and redirected receipts inside the canonical envelope", async () => {
    const context = {
      ...fixtureContext(undefined),
      secrets: { get: () => "brave-key" },
    };
    const fixture = fixtureHttp((request) => {
      const url = new URL(request.url);
      if (url.hostname === "api.search.brave.com") {
        const query = url.searchParams.get("q")!;
        const results = Array.from({ length: 5 }, (_, index) => {
          const prefix = `https://publisher.example/${query}/${index}/`;
          return {
            title: "字".repeat(180),
            description: "字".repeat(800),
            url: prefix + "x".repeat(1024 - prefix.length),
          };
        });
        return fixtureResponse(
          request.url,
          JSON.stringify({ web: { results } }),
          { contentType: "application/json" },
        );
      }
      if (url.pathname.startsWith("/alpha/0/"))
        return fixtureResponse(request.url, "Forbidden", { status: 403 });
      const prefix = `https://final.example${url.pathname.slice(0, 10)}/`;
      return {
        ...fixtureResponse(
          request.url,
          article("字".repeat(180), "字".repeat(12_000)),
        ),
        finalUrl: prefix + "x".repeat(4096 - prefix.length),
      };
    });
    const result = await createWebPlugin(context, fixture).handlers.web_search!(
      { queries: ["alpha", "beta", "gamma", "delta", "epsilon"] },
    );
    const eventMeta = result.data?.eventMeta as {
      webSources: WebSourcesReceipt;
    };
    expect(result).toMatchObject({ ok: true });
    expect(eventMeta.webSources.omittedSourceCount).toBeGreaterThan(0);
    expect(
      eventMeta.webSources.sources.length +
        eventMeta.webSources.omittedSourceCount!,
    ).toBe(25);
    expect(
      eventMeta.webSources.sources.filter(({ url }) => url.length === 4096),
    ).toHaveLength(5);
    expect(
      eventMeta.webSources.sources.every(
        ({ requestedUrl }) => !requestedUrl || requestedUrl.length <= 1024,
      ),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
      128 * 1024,
    );
  });

  test("adds Brave receipts and preserves the prior metadata fields", async () => {
    const url = "https://publisher.example/article";
    const context = {
      ...fixtureContext(undefined),
      secrets: { get: () => "brave-key" },
    };
    const fixture = fixtureHttp((request) => {
      if (request.url.startsWith("https://api.search.brave.com/"))
        return fixtureResponse(
          request.url,
          JSON.stringify({
            web: {
              results: [
                { title: "An article", url, description: "Search snippet" },
              ],
            },
          }),
          { contentType: "application/json" },
        );
      return {
        ...fixtureResponse(
          request.url,
          article("Page title", "Readable article content"),
        ),
        finalUrl: `${url}/final`,
      };
    });
    const result = await createWebPlugin(context, fixture).handlers.web_search!(
      { query: "topic" },
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        itemCount: 1,
        eventMeta: {
          query: "topic",
          queries: ["topic"],
          urls: [url],
          fetchedUrls: [`${url}/final`],
          partialFetchedUrls: [],
          sourceFetchErrors: [],
          webSources: {
            version: 1,
            operation: "search",
            provider: "brave",
            sources: [
              {
                url: `${url}/final`,
                requestedUrl: url,
                title: "An article",
                retrieval: "retrieved",
                presentation: "content",
                contentTruncated: false,
              },
            ],
          },
        },
      },
    });
  });

  test("reports Light hit retrieval independently of the six content-block limit", async () => {
    const queries = ["alpha", "beta"];
    const source = { ...fixtureSource("receipt", "alpha"), keywords: queries };
    const entries = queries.flatMap((query) =>
      Array.from({ length: 5 }, (_, index) => ({
        title: query,
        url: `${source.allowedOrigins[0]}/${query}-${index}`,
      })),
    );
    const fixture = fixtureHttp(({ url }) =>
      url === source.entryUrls[0]
        ? fixtureResponse(url, feed(entries), {
            contentType: "application/rss+xml",
          })
        : fixtureResponse(
            url,
            article(
              new URL(url).pathname.includes("alpha") ? "alpha" : "beta",
              new URL(url).pathname,
            ),
          ),
    );
    const result = await createWebPlugin(
      fixtureContext({ sources: [source], sourceLimit: 1, maxRequests: 40 }),
      fixture,
    ).handlers.web_search!({ queries });
    const eventMeta = result.data?.eventMeta as {
      fetchedUrls: string[];
      webSources: WebSourcesReceipt;
    };
    expect(eventMeta.webSources).toMatchObject({
      version: 1,
      operation: "search",
      provider: "light",
    });
    expect(eventMeta.webSources.sources).toHaveLength(10);
    expect(eventMeta.fetchedUrls).toHaveLength(6);
    expect(
      eventMeta.webSources.sources.every(
        ({ retrieval }) => retrieval === "retrieved",
      ),
    ).toBe(true);
    expect(
      eventMeta.webSources.sources.filter(
        ({ presentation }) => presentation === "content",
      ),
    ).toHaveLength(6);
    expect(
      eventMeta.webSources.sources.filter(
        ({ presentation }) => presentation === "snippet",
      ),
    ).toHaveLength(4);
  });

  test("adds fetch receipts without a search provider", async () => {
    const url = "https://publisher.example/article";
    const fixture = fixtureHttp(({ url: requested }) =>
      fixtureResponse(requested, article("Article title", "Readable evidence")),
    );
    const result = await createWebPlugin(fixtureContext(undefined), fixture)
      .handlers.web_fetch!({ url });
    const eventMeta = result.data?.eventMeta as {
      webSources: WebSourcesReceipt;
    };
    expect(eventMeta.webSources).toMatchObject({
      version: 1,
      operation: "fetch",
      sources: [
        {
          url,
          title: "Article title",
          retrieval: "retrieved",
          presentation: "content",
        },
      ],
    });
    expect(eventMeta.webSources).not.toHaveProperty("provider");
  });

  test("retains all-or-nothing fetch failure semantics", async () => {
    const fixture = fixtureHttp(({ url }) =>
      fixtureResponse(url, "Forbidden", { status: 403 }),
    );
    const result = await createWebPlugin(fixtureContext(undefined), fixture)
      .handlers.web_fetch!({
      urls: ["https://publisher.example/a", "https://publisher.example/b"],
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "web_fetch_http_error",
    });
    expect(result.data?.eventMeta).toBeUndefined();
  });
});
