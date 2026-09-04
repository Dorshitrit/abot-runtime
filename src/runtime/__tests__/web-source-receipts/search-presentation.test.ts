import { describe, expect, test } from "vitest";

import { hit, page, presentSearch } from "./receipt-fixture.js";

describe("search source receipts", () => {
  test("distinguishes reference, snippet, failed retrieval and readable content", () => {
    const hits = [hit(0, { snippet: "" }), hit(1), hit(2), hit(3)];
    const result = presentSearch(hits, [
      { hit: hits[2]!, error: "HTTP 403", errorCode: "web_fetch_http_error" },
      { hit: hits[3]!, page: page(hits[3]!.url) },
    ]);
    expect(
      result.sources.map(({ retrieval, presentation, contentTruncated }) => ({
        retrieval,
        presentation,
        contentTruncated,
      })),
    ).toEqual([
      {
        retrieval: "not_attempted",
        presentation: "reference",
        contentTruncated: false,
      },
      {
        retrieval: "not_attempted",
        presentation: "snippet",
        contentTruncated: false,
      },
      { retrieval: "failed", presentation: "snippet", contentTruncated: false },
      {
        retrieval: "retrieved",
        presentation: "content",
        contentTruncated: false,
      },
    ]);
    expect(result.output).toContain("Source fetch failed: HTTP 403");
  });

  test("uses final URL and retains requested URL without rewriting evidence", () => {
    const source = hit();
    const result = presentSearch(
      [source],
      [
        {
          hit: source,
          page: page(source.url, {
            finalUrl: "https://publisher.example/article",
          }),
        },
      ],
    );
    expect(result.sources[0]).toMatchObject({
      url: "https://publisher.example/article",
      requestedUrl: source.url,
      title: source.title,
      presentation: "content",
    });
    expect(result.output).toContain(`url_json: "${source.url}"`);
    expect(result.output).not.toContain("https://publisher.example/article");
  });

  test.each(["", " \n\t"])(
    "does not count an empty readable body as content (%j)",
    (text) => {
      const source = hit();
      expect(
        presentSearch(
          [source],
          [{ hit: source, page: page(source.url, { text }) }],
        ).sources[0],
      ).toMatchObject({
        retrieval: "retrieved",
        presentation: "snippet",
        contentTruncated: false,
      });
    },
  );

  test.each([
    { text: "x".repeat(3_100), partialContent: false },
    { text: "A partial page", partialContent: true },
  ])("marks per-source text or fetch truncation", (overrides) => {
    const source = hit();
    const result = presentSearch(
      [source],
      [{ hit: source, page: page(source.url, overrides) }],
    );
    expect(result.sources[0]).toMatchObject({
      presentation: "content",
      contentTruncated: true,
    });
  });

  test("tracks the final character boundary and retains omitted sources", () => {
    const hits = Array.from({ length: 10 }, (_, index) => hit(index));
    const result = presentSearch(
      hits,
      hits.map((source) => ({
        hit: source,
        page: page(source.url, { text: "c".repeat(2_900) }),
      })),
    );
    const content = result.sources.filter(
      ({ presentation }) => presentation === "content",
    );
    const omitted = result.sources.filter(
      ({ presentation }) => presentation === "omitted",
    );
    expect(result.output).toHaveLength(16_000);
    expect(result.coverage.outputTruncated).toBe(true);
    expect(content.at(-1)?.contentTruncated).toBe(true);
    expect(omitted.length).toBeGreaterThan(0);
    for (const source of omitted)
      expect(result.output).not.toContain(`url_json: "${source.url}"`);
  });

  test("deduplicates repeated query results and keeps the strongest visible occurrence", () => {
    const first = hit(0, { snippet: "" });
    const repeated = {
      ...first,
      query: "second",
      snippet: "Second query evidence.",
    };
    const result = presentSearch(
      [first],
      [],
      [
        { query: "first", hits: [first] },
        { query: "second", hits: [repeated] },
      ],
    );
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.presentation).toBe("snippet");
    expect(result.output.match(/url_json:/gu)).toHaveLength(2);
  });

  test("keeps a complete first occurrence when a duplicate is omitted later", () => {
    const source = hit();
    const fillers = Array.from({ length: 8 }, (_, index) => hit(index + 1));
    const result = presentSearch(
      [source, ...fillers],
      fillers.map((filler) => ({
        hit: filler,
        page: page(filler.url, { text: "x".repeat(3_000) }),
      })),
      [
        { query: "first", hits: [source, ...fillers] },
        { query: "second", hits: [source] },
      ],
    );
    expect(result.coverage.outputTruncated).toBe(true);
    expect(result.sources[0]).toMatchObject({
      presentation: "snippet",
      contentTruncated: false,
    });
  });
});
