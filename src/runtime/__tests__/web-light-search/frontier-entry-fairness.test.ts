import { expect, test } from "vitest";
import { createLightSearchService } from "../../../../plugins/web/source/light/search-service.js";
import {
  article,
  feed,
  fixtureHttp,
  fixtureResponse,
  fixtureSource,
} from "./search-fixture.js";

test.each([256, 48])(
  "six sources with eight feeds still fetch articles within 24 hops and candidate limit %i",
  async (maxCandidates) => {
    const sources = Array.from({ length: 6 }, (_, index) => {
      const source = fixtureSource(`publisher-${index}`, "astronomy");
      return {
        ...source,
        title: "Astronomy publisher",
        entryUrls: Array.from(
          { length: 8 },
          (_, feedIndex) => `${source.allowedOrigins[0]}/feed-${feedIndex}.xml`,
        ),
      };
    });
    const fixture = fixtureHttp(({ url }) => {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith("/feed-")) {
        return fixtureResponse(
          url,
          feed([
            { title: "Astronomy observation", url: `${parsed.origin}/article` },
          ]),
          { contentType: "application/rss+xml" },
        );
      }
      return fixtureResponse(
        url,
        article(
          "Astronomy observation",
          "Astronomy observation supported by the article content.",
        ),
      );
    });
    const service = createLightSearchService({
      httpClient: fixture.httpClient,
      config: { sources, sourceLimit: 6, maxRequests: 24, maxCandidates },
    });
    const result = await service.search(["astronomy"]);
    const requested = fixture.requests.map(({ url }) => new URL(url));
    const feedRequests = requested.filter(({ pathname }) =>
      pathname.startsWith("/feed-"),
    );
    const articleRequests = requested.filter(
      ({ pathname }) => pathname === "/article",
    );
    expect(
      new Set(feedRequests.slice(0, 6).map(({ origin }) => origin)).size,
    ).toBe(6);
    expect(articleRequests).toHaveLength(6);
    expect(result.hits).toHaveLength(5);
    expect(result.hits.every(({ url }) => url.endsWith("/article"))).toBe(true);
    expect(result.lightSearch?.requests).toBeLessThanOrEqual(24);
  },
);
