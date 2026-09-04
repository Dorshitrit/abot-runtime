import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
} from "node:zlib";
import { describe, expect, test } from "vitest";

import { decodeLightResponse } from "../../../../plugins/web/source/light/documents/response-decoding.js";
import { parseLightDocument } from "../../../../plugins/web/source/light/documents/extract-document.js";
import type { PublicHttpResponse } from "../../../../plugins/web/source/public-http.js";

function response(
  body: Uint8Array,
  encoding = "identity",
  contentType = "text/html",
): PublicHttpResponse {
  return {
    requestedUrl: "https://publisher.example/source",
    finalUrl: "https://publisher.example/source",
    status: 200,
    headers: { "content-type": contentType, "content-encoding": encoding },
    body,
    bytesRead: body.length,
    partialContent: false,
  };
}

describe("Light-only response decoding", () => {
  const html = Buffer.from(
    "<title>Readable source</title><main>Useful bounded article text.</main>",
  );

  test.each([
    ["gzip", gzipSync],
    ["br", brotliCompressSync],
    ["deflate", deflateSync],
    ["deflate", deflateRawSync],
  ] as const)(
    "decodes %s while normalizing only the Light response",
    (encoding, compress) => {
      const original = response(compress(html), encoding);
      const decoded = decodeLightResponse(original, 512 * 1024);
      expect(decoded.body).toEqual(html);
      expect(decoded.headers["content-encoding"]).toBe("identity");
      expect(original.headers["content-encoding"]).toBe(encoding);
      expect(decoded.bytesRead).toBe(html.length);
      expect(parseLightDocument(decoded, 5)).toMatchObject({
        kind: "page",
        title: "Readable source",
        canonicalUrl: original.finalUrl,
      });
    },
  );

  test("accepts gzip sitemap files without an HTTP content-encoding header", () => {
    const sitemap = Buffer.from(
      "<urlset><url><loc>https://publisher.example/article</loc></url></urlset>",
    );
    const original = {
      ...response(gzipSync(sitemap), "identity", "application/gzip"),
      finalUrl: "https://publisher.example/sitemap.xml.gz",
    };
    expect(
      parseLightDocument(decodeLightResponse(original, 512 * 1024), 5),
    ).toMatchObject({
      kind: "sitemap",
      links: [{ url: "https://publisher.example/article", kind: "page" }],
    });
  });

  test("rejects oversized decompression and unknown/chained encodings", () => {
    const compressed = gzipSync(Buffer.alloc(100_000, 65));
    expect(() =>
      decodeLightResponse(response(compressed, "gzip"), 1_024),
    ).toThrow(/decoded response limit/);
    expect(() =>
      decodeLightResponse(response(html, "gzip, br"), 1_024),
    ).toThrow(/unsupported content encoding/);
    expect(() =>
      decodeLightResponse(response(Buffer.from("invalid gzip"), "gzip"), 1_024),
    ).toThrow(/encoded source is invalid/);
  });

  test("retains bounded identity partial content and enforces the hard decoded ceiling", () => {
    const decoded = decodeLightResponse(response(html), 10);
    expect(decoded.body).toHaveLength(10);
    expect(decoded.partialContent).toBe(true);
    expect(() =>
      decodeLightResponse(
        response(gzipSync(Buffer.alloc(600_000)), "gzip"),
        1_000_000,
      ),
    ).toThrow(/decoded response limit/);
    expect(() => decodeLightResponse(response(html), 0)).toThrow(RangeError);
  });

  test("does not assign unfetched HTML canonical identity or treat HTTP failures as documents", () => {
    const document = parseLightDocument(
      response(
        Buffer.from(
          '<link rel="canonical" href="https://unfetched.example"><main>Actual source.</main>',
        ),
      ),
      5,
    );
    expect(document.canonicalUrl).toBe("https://publisher.example/source");
    expect(document.links).toEqual([]);
    expect(() =>
      parseLightDocument({ ...response(html), status: 403 }, 5),
    ).toThrow(/HTTP 403/);
  });
});
