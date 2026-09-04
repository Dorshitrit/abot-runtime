import { describe, expect, test } from "vitest";

import { parseLightDocument } from "../../../../plugins/web/source/light/documents/extract-document.js";
import type { PublicHttpResponse } from "../../../../plugins/web/source/public-http.js";

function response(
  body: string,
  contentType = "text/html",
  url = "https://publisher.example/root/index.html",
): PublicHttpResponse {
  const bytes = Buffer.from(body);
  return {
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    headers: { "content-type": contentType },
    body: bytes,
    bytesRead: bytes.length,
    partialContent: false,
  };
}

describe("bounded Light source discovery", () => {
  test("extracts HTML relative links, feed advertisements, dates and actual fetched identity", () => {
    const document = parseLightDocument(
      response(`<!doctype html><html><head>
      <base href="/articles/"><title>Publisher</title>
      <link rel="canonical" href="https://unfetched.example/canonical">
      <link rel="alternate" type="application/rss+xml" href="../feed.xml">
      <meta property="article:published_time" content="2026-03-01T10:00:00Z">
      <meta property="article:modified_time" content="2026-03-02T10:00:00Z">
      </head><body><main>Useful publisher article content for source discovery and local search.</main>
      <a href="first?x=1&amp;y=2#section">First &amp; useful</a>
      <a href="first?x=1&amp;y=2#other">Duplicate</a>
      <a href="javascript:alert(1)">Unsafe</a><a href="http://127.0.0.1/private">Private</a>
      <a rel="nofollow" href="ignored">Ignored</a>
      <script>const fake = '<a href="fake">Fake</a>';</script>
      </body></html>`),
      5,
    );
    expect(document).toMatchObject({
      kind: "page",
      canonicalUrl: "https://publisher.example/root/index.html",
      title: "Publisher",
      publishedAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-02T10:00:00.000Z",
      partial: false,
    });
    expect(document.links).toEqual([
      { url: "https://publisher.example/feed.xml", title: "", kind: "feed" },
      {
        url: "https://publisher.example/articles/first?x=1&y=2",
        title: "First & useful",
        kind: "page",
      },
    ]);
  });

  test("respects page nofollow and marks bounded discovery partial", () => {
    expect(
      parseLightDocument(
        response(
          '<meta name="robots" content="index,nofollow"><a href="/one">One</a>',
        ),
        5,
      ).links,
    ).toEqual([]);
    const bounded = parseLightDocument(
      response('<a href="/one">One</a><a href="/two">Two</a>'),
      1,
    );
    expect(bounded.links).toHaveLength(1);
    expect(bounded.partial).toBe(true);
    expect(
      parseLightDocument(response('<a href="/one">One</a>'), 0),
    ).toMatchObject({ links: [], partial: true });
  });

  test("parses namespaced RSS, CDATA, GUID fallback, XML bases and published dates", () => {
    const document = parseLightDocument(
      response(
        `<?xml version="1.0"?>
      <rss xmlns:dc="urn:dc" xmlns:content="urn:content" xml:base="https://publisher.example/news/"><channel>
      <title>News &amp; Research</title><description>Publisher feed</description>
      <item xml:base="2026/"><title><![CDATA[Research & results]]></title><link>report</link>
      <content:encoded><![CDATA[<p>A useful <b>research</b> result.</p>]]></content:encoded>
      <dc:date>2026-03-03T12:00:00Z</dc:date></item>
      <item><title>GUID result</title><guid isPermaLink="true">fallback</guid></item>
      <item><title>Opaque GUID</title><guid isPermaLink="false">opaque</guid></item>
      <item><title>Duplicate</title><link>2026/report#other</link></item>
      </channel></rss>`,
        "application/rss+xml",
      ),
      10,
    );
    expect(document.kind).toBe("feed");
    expect(document.title).toBe("News & Research");
    expect(document.links).toEqual([
      {
        url: "https://publisher.example/news/2026/report",
        title: "Research & results",
        kind: "page",
        text: "A useful research result.",
        publishedAt: "2026-03-03T12:00:00.000Z",
      },
      {
        url: "https://publisher.example/news/fallback",
        title: "GUID result",
        kind: "page",
      },
    ]);
  });

  test("parses Atom alternate links, nested xml:base and separate publication/update dates", () => {
    const document = parseLightDocument(
      response(
        `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xml:base="/feed/">
      <atom:title>Atom feed</atom:title><atom:updated>2026-04-04T00:00:00Z</atom:updated>
      <atom:entry xml:base="../articles/"><atom:title>Atom article</atom:title>
      <atom:link rel="self" href="entry.xml"/><atom:link rel="alternate" xml:base="science/" href="first"/>
      <atom:published>2026-04-02T00:00:00Z</atom:published><atom:updated>2026-04-03T00:00:00Z</atom:updated>
      <atom:summary type="html">&lt;p&gt;Article summary&lt;/p&gt;</atom:summary></atom:entry>
      </atom:feed>`,
        "application/atom+xml",
      ),
      5,
    );
    expect(document).toMatchObject({
      kind: "feed",
      updatedAt: "2026-04-04T00:00:00.000Z",
    });
    expect(document.links).toEqual([
      {
        url: "https://publisher.example/articles/science/first",
        title: "Atom article",
        kind: "page",
        text: "Article summary",
        publishedAt: "2026-04-02T00:00:00.000Z",
        updatedAt: "2026-04-03T00:00:00.000Z",
      },
    ]);
  });

  test("parses sitemap indexes and namespaced URL sets with bounded candidates", () => {
    const index = parseLightDocument(
      response(
        `<sm:sitemapindex xmlns:sm="urn:sitemap" xml:base="/maps/">
      <sm:sitemap><sm:loc>part-1.xml.gz</sm:loc><sm:lastmod>2026-02-02</sm:lastmod></sm:sitemap>
      <sm:sitemap><sm:loc>part-2.xml</sm:loc></sm:sitemap></sm:sitemapindex>`,
        "application/xml",
      ),
      1,
    );
    expect(index).toMatchObject({ kind: "sitemap", partial: true });
    expect(index.links).toEqual([
      {
        url: "https://publisher.example/maps/part-1.xml.gz",
        title: "",
        kind: "sitemap",
        updatedAt: "2026-02-02T00:00:00.000Z",
      },
    ]);
    const urls = parseLightDocument(
      response(
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>../article</loc><lastmod>not-a-date</lastmod></url>
      <url><loc>file:///private</loc></url><url><loc>http://localhost/private</loc></url>
      </urlset>`,
        "application/xml",
      ),
      5,
    );
    expect(urls.links).toEqual([
      { url: "https://publisher.example/article", title: "", kind: "page" },
    ]);
  });

  test("rejects entity declarations and XML doctypes without processing them", () => {
    for (const xml of [
      '<!DOCTYPE rss SYSTEM "https://unfetched.example/schema"><rss/>',
      '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><title>&x;</title></channel></rss>',
      '<!ENTITY x "payload"><rss/>',
    ]) {
      expect(() =>
        parseLightDocument(response(xml, "application/xml"), 5),
      ).toThrow();
    }
  });

  test("bounds markup depth and propagates transport partial status", () => {
    expect(() =>
      parseLightDocument(
        response("<div>".repeat(70) + "text" + "</div>".repeat(70)),
        5,
      ),
    ).toThrow(/parsing limits/);
    expect(
      parseLightDocument(
        {
          ...response(
            "<rss><channel><title>Partial</title></channel></rss>",
            "application/rss+xml",
          ),
          partialContent: true,
        },
        5,
      ).partial,
    ).toBe(true);
    expect(() => parseLightDocument(response("<p>Text</p>"), -1)).toThrow(
      RangeError,
    );
  });
});
