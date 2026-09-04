import { describe, expect, test } from "vitest";

import { createLightSearchService } from "../../../../plugins/web/source/light/search-service.js";
import { createDocumentCache } from "../../../../plugins/web/source/light/documents/document-cache.js";
import { parseLightDocument } from "../../../../plugins/web/source/light/documents/extract-document.js";
import {
  fixtureHttp,
  fixtureResponse,
  fixtureSource,
} from "./search-fixture.js";

describe("Light page indexing directives", () => {
  test("removes a cached canonical page when a new alias reveals noindex", () => {
    const cache = createDocumentCache({
      cacheMaxDocuments: 10,
      cacheMaxBytes: 10_000,
    });
    const url = "https://publisher.example/article";
    const record = {
      sourceId: "publisher",
      document: parseLightDocument(
        fixtureResponse(url, "<title>Astronomy</title>"),
        5,
      ),
      fetchedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: 10_000,
    };
    cache.put(record, url, 0);
    expect(cache.size()).toBe(1);
    cache.put(
      {
        ...record,
        document: parseLightDocument(
          fixtureResponse(
            url,
            '<title>Astronomy</title><meta name="robots" content="index,follow"><meta name="ROBOTS" content="noindex">',
          ),
          5,
        ),
      },
      "https://publisher.example/alias",
      0,
    );
    expect(cache.size()).toBe(0);
    expect(cache.get(url, 0)).toBeUndefined();
    expect(cache.forSources(new Set(["publisher"]), 0)).toEqual([]);
  });

  test.each(["noindex,follow", "none", "NOINDEX"])(
    "does not return or cache a page declaring %s",
    async (directive) => {
      const source = fixtureSource("publisher", "astronomy");
      const fixture = fixtureHttp(({ url }) =>
        fixtureResponse(
          url,
          `<title>Astronomy private preview</title><meta name="robots" content="${directive}"><main>Astronomy unpublished findings.</main>`,
        ),
      );
      const service = createLightSearchService({
        httpClient: fixture.httpClient,
        config: { sources: [source] },
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await service.search(["astronomy"]);
        expect(result.hits).toEqual([]);
        expect(result.sourceFetches).toEqual([]);
        expect(result.output).not.toContain("unpublished findings");
      }
      expect(
        fixture.requests.filter(({ url }) => url === source.entryUrls[0]),
      ).toHaveLength(2);
    },
  );

  test.each([
    { directive: "noindex,follow", expected: ["/article"] },
    { directive: "index,nofollow", expected: ["/feed.xml"] },
    { directive: "none", expected: [] },
  ])(
    "separates indexing from link traversal for $directive",
    async ({ directive, expected }) => {
      const source = fixtureSource("publisher", "astronomy");
      const fixture = fixtureHttp(({ url }) => {
        const body =
          url === source.entryUrls[0]
            ? `<title>Astronomy landing</title><meta name="robots" content="${directive}"><a href="/article">Astronomy article</a>`
            : "<title>Astronomy article</title><main>Astronomy public findings.</main>";
        return fixtureResponse(url, body);
      });
      const result = await createLightSearchService({
        httpClient: fixture.httpClient,
        config: { sources: [source] },
      }).search(["astronomy"]);
      expect(result.hits.map(({ url }) => new URL(url).pathname)).toEqual(
        expected,
      );
      expect(
        fixture.requests.some(
          ({ url }) => new URL(url).pathname === "/article",
        ),
      ).toBe(directive === "noindex,follow");
    },
  );
});
