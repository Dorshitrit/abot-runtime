import { describe, expect, test } from "vitest";
import {
  isRobotsPathAllowed,
  parseRobotsDocument,
} from "../../../../plugins/web/source/light/crawl/robots-parser.js";

describe("Light robots policy parsing", () => {
  test("combines exact product groups and ignores the wildcard group when matched", () => {
    const document = parseRobotsDocument(
      [
        "User-agent: *",
        "Disallow: /",
        "User-agent: ABOT-runtime-WEB",
        "Disallow: /private",
        "User-agent: abot-runtime-web",
        "Disallow: /other",
        "Allow: /private/public",
      ].join("\n"),
    );
    expect(
      isRobotsPathAllowed(document, new URL("https://example.org/page")),
    ).toBe(true);
    expect(
      isRobotsPathAllowed(document, new URL("https://example.org/private")),
    ).toBe(false);
    expect(
      isRobotsPathAllowed(document, new URL("https://example.org/other")),
    ).toBe(false);
    expect(
      isRobotsPathAllowed(
        document,
        new URL("https://example.org/private/public"),
      ),
    ).toBe(true);
  });

  test.each([
    ["/path/exact", true],
    ["/path/exact?query=1", false],
    ["/path/other", false],
    ["/elsewhere", true],
  ])(
    "handles wildcard, terminal anchor and allow precedence for %s",
    (path, allowed) => {
      const document = parseRobotsDocument(
        "User-agent: *\nDisallow: /path/*\nAllow: /path/exact$",
      );
      expect(
        isRobotsPathAllowed(document, new URL(path, "https://example.org")),
      ).toBe(allowed);
    },
  );

  test("allow wins equal-specificity rules and robots.txt stays accessible", () => {
    const document = parseRobotsDocument(
      "User-agent: *\nAllow: /equal\nDisallow: /equal\nDisallow: /",
    );
    expect(
      isRobotsPathAllowed(document, new URL("https://example.org/equal")),
    ).toBe(true);
    expect(
      isRobotsPathAllowed(document, new URL("https://example.org/robots.txt")),
    ).toBe(true);
  });

  test("normalizes Hebrew and unreserved percent encoding but preserves reserved slash", () => {
    const document = parseRobotsDocument(
      "User-agent: *\nDisallow: /שלום\nDisallow: /private\nDisallow: /with%2fslash",
    );
    expect(
      isRobotsPathAllowed(document, new URL("https://example.org/שלום")),
    ).toBe(false);
    expect(
      isRobotsPathAllowed(document, new URL("https://example.org/%70rivate")),
    ).toBe(false);
    expect(
      isRobotsPathAllowed(
        document,
        new URL("https://example.org/with%2Fslash"),
      ),
    ).toBe(false);
    expect(
      isRobotsPathAllowed(document, new URL("https://example.org/with/slash")),
    ).toBe(true);
  });

  test("matches percent-encoded literal wildcard and dollar characters in URLs", () => {
    const document = parseRobotsDocument(
      "User-agent: *\nDisallow: /file%2A.html\nDisallow: /foo%24",
    );
    expect(
      isRobotsPathAllowed(document, new URL("https://example.org/file*.html")),
    ).toBe(false);
    expect(
      isRobotsPathAllowed(document, new URL("https://example.org/foo$")),
    ).toBe(false);
    expect(
      isRobotsPathAllowed(
        document,
        new URL("https://example.org/file-other.html"),
      ),
    ).toBe(true);
  });

  test("retains sitemap metadata without ending the current group", () => {
    const document = parseRobotsDocument(
      [
        "Disallow: /ignored",
        "User-agent: *",
        "Disallow:",
        "Sitemap: https://example.org/sitemap.xml",
        "Disallow: /hidden # reason",
        "Malformed line",
        "Allow: /hidden/public",
      ].join("\n"),
    );
    expect(document.sitemaps).toEqual(["https://example.org/sitemap.xml"]);
    expect(
      isRobotsPathAllowed(document, new URL("https://example.org/ignored")),
    ).toBe(true);
    expect(
      isRobotsPathAllowed(document, new URL("https://example.org/hidden")),
    ).toBe(false);
    expect(
      isRobotsPathAllowed(
        document,
        new URL("https://example.org/hidden/public"),
      ),
    ).toBe(true);
  });
});
