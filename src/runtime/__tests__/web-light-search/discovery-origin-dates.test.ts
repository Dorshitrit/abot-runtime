import { describe, expect, test } from "vitest";

import { parseLightDocument } from "../../../../plugins/web/source/light/documents/extract-document.js";
import { fixtureResponse } from "./search-fixture.js";

function document(markup: string, type = "text/html") {
  return parseLightDocument(
    fixtureResponse("https://publisher.example/article", markup, {
      contentType: type,
    }),
    8,
  );
}

describe("dates explicitly declared by the fetched origin document", () => {
  test.each(["name", "property", "itemprop"])(
    "extracts schema date fields from the %s attribute",
    (attribute) => {
      const result = document(`<title>Article</title>
      <meta ${attribute}="datePublished" content="2026-03-04T00:30:00+02:00">
      <meta ${attribute}="dateModified" content="2026-03-05">
      <main>Article evidence.</main>`);
      expect(result).toMatchObject({
        publishedAt: "2026-03-03T22:30:00.000Z",
        updatedAt: "2026-03-05T00:00:00.000Z",
      });
    },
  );

  test.each([
    "2026-02-30",
    "2026-13-01",
    "2026-03-04T24:00:00Z",
    "2026-03-04T10:00:00",
    "03/04/2026",
    "tomorrow",
    "1700000000",
  ])("omits ambiguous or invalid origin date %s", (date) => {
    const result =
      document(`<meta property="article:published_time" content="${date}">
      <meta property="article:modified_time" content="${date}"><main>Origin page.</main>`);
    expect(result.publishedAt).toBeUndefined();
    expect(result.updatedAt).toBeUndefined();
  });

  test("reads only named metadata, keeps modified distinct, and ignores dates in body content", () => {
    const result =
      document(`<meta name="dateModified" content="2024-02-29T12:00:00Z">
      <meta name="unrelated" content="2026-01-01"><main>Published 2026-01-01.
      &lt;meta property="article:published_time" content="2026-01-01"&gt;</main>`);
    expect(result.publishedAt).toBeUndefined();
    expect(result.updatedAt).toBe("2024-02-29T12:00:00.000Z");
  });

  test("leaves sitemap lastmod on the discovered link without asserting article publication", () => {
    const sitemap = document(
      `<urlset><url><loc>https://publisher.example/article</loc>
      <lastmod>2026-03-01</lastmod></url></urlset>`,
      "application/xml",
    );
    expect(sitemap.links[0]).toMatchObject({
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(sitemap.publishedAt).toBeUndefined();
    expect(sitemap.updatedAt).toBeUndefined();
    const article = document("<main>Content without declared dates.</main>");
    expect(article.publishedAt).toBeUndefined();
    expect(article.updatedAt).toBeUndefined();
  });
});
