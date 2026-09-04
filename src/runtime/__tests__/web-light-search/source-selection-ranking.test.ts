import { describe, expect, test } from "vitest";

import { WEB_LIMITS } from "../../../../plugins/web/source/limits.js";
import type { LightCachedDocument } from "../../../../plugins/web/source/light/documents/document-cache.js";
import { rankLightDocuments } from "../../../../plugins/web/source/light/ranking/document-ranking.js";
import { selectLightSources } from "../../../../plugins/web/source/light/sources/source-selection.js";
import { fixtureSource } from "./search-fixture.js";

function observedDocument(
  id: string,
  title: string,
  text: string,
): LightCachedDocument {
  const url = `https://publisher.example/${id}`;
  return {
    sourceId: "publisher",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: Date.UTC(2027, 0, 1),
    document: {
      canonicalUrl: url,
      kind: "page",
      title,
      text,
      links: [],
      partial: false,
    },
    page: {
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: "text/html",
      title,
      text,
      bytesRead: Buffer.byteLength(text),
      partialContent: false,
    },
  };
}

describe("bounded source selection", () => {
  const sources = [
    fixtureSource("astronomy", "telescope"),
    fixtureSource("cooking", "recipes"),
    fixtureSource("science", "telescope"),
    fixtureSource("gardening", "plants"),
  ];

  test("stops after positive matches instead of filling the limit with unrelated sources", () => {
    expect(
      selectLightSources(["telescope"], sources, 6).map(({ id }) => id),
    ).toEqual(["astronomy", "science"]);
  });

  test("preserves bounded corpus fallback for a query with no source matches", () => {
    expect(
      selectLightSources(["unmatched subject"], sources, 2).map(({ id }) => id),
    ).toEqual(["astronomy", "cooking"]);
  });

  test("keeps per-query opportunities and allows fallback only for unmatched queries", () => {
    expect(
      selectLightSources(["telescope", "recipes"], sources, 2).map(
        ({ id }) => id,
      ),
    ).toEqual(["astronomy", "cooking"]);
    expect(
      selectLightSources(["plants", "unmatched subject"], sources, 3).map(
        ({ id }) => id,
      ),
    ).toEqual(["gardening", "astronomy", "cooking"]);
  });
});

describe("generic lexical document ranking", () => {
  test("prefers an exact topic title over longer ancillary titles and repeated body mentions", () => {
    const primary = observedDocument(
      "topic",
      "Lunar Telescope",
      "An optical instrument studies lunar terrain.",
    );
    const related = observedDocument(
      "committee",
      "Lunar Telescope Administrative Committee",
      "Lunar telescope committee administration and meetings. ".repeat(300),
    );
    const unrelated = observedDocument(
      "unrelated",
      "Garden",
      "Growing herbs and roses.",
    );
    const result = rankLightDocuments(
      ["what is the lunar telescope"],
      [related, unrelated, primary],
    );
    expect(result.hits.map(({ url }) => url)).toEqual([
      "https://publisher.example/topic",
      "https://publisher.example/committee",
    ]);
    expect(result.sourceFetches[0]?.page?.text).toBe(primary.document.text);
  });

  test("keeps both a short topic index and full matching article as retrieved evidence", () => {
    const index = observedDocument(
      "index",
      "Atlas",
      "Atlas articles and updates.",
    );
    const article = observedDocument(
      "article",
      "Researchers publish Atlas observations",
      "This article reports detailed Atlas evidence from instrument observations.",
    );
    const result = rankLightDocuments(["articles Atlas"], [index, article]);
    expect(new Set(result.hits.map(({ url }) => url))).toEqual(
      new Set([
        "https://publisher.example/index",
        "https://publisher.example/article",
      ]),
    );
  });

  test("retains ranked hits for every query while bounding full source evidence", () => {
    const records = ["alpha", "beta"].flatMap((term) =>
      Array.from({ length: 6 }, (_, index) =>
        observedDocument(
          `${term}-${index}`,
          `${term} discovery ${index}`,
          `Retrieved ${term} research evidence.`,
        ),
      ),
    );
    const result = rankLightDocuments(["alpha", "beta"], records);
    expect(result.results.map(({ hits }) => hits.length)).toEqual([
      WEB_LIMITS.searchResultsPerQuery,
      WEB_LIMITS.searchResultsPerQuery,
    ]);
    expect(result.hits).toHaveLength(2 * WEB_LIMITS.searchResultsPerQuery);
    expect(result.sourceFetches).toHaveLength(WEB_LIMITS.searchSourceFetches);
    expect(
      result.sourceFetches.every(({ hit, page }) => page?.finalUrl === hit.url),
    ).toBe(true);
  });
});
