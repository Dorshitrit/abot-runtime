import { describe, expect, test } from "vitest";

import { readLinkPreviewMetadata } from "../../../web-ui/link-preview/metadata.js";
import { readPreviewRaster } from "../../../web-ui/link-preview/raster-response.js";
import { pngResponse, previewResponse } from "./preview-fixtures.js";

describe("link preview metadata", () => {
  test("uses bounded Open Graph text and resolves relative image URLs after redirects", () => {
    const preview = readLinkPreviewMetadata(
      previewResponse(
        `<html><head>
      <title>Fallback</title><meta property="og:title" content="News &amp; updates">
      <meta name="description" content="Fallback description">
      <meta property="og:description" content="  A useful   description ">
      <meta property="og:site_name" content="Example News">
      <meta property="og:image" content="../photo.png">
      </head><body><meta property="og:title" content="Body is ignored"></body></html>`,
        { finalUrl: "https://example.com/articles/story" },
      ),
    );
    expect(preview).toEqual({
      url: "https://example.com/articles/story",
      title: "News & updates",
      description: "A useful description",
      siteName: "Example News",
      imageUrl: "https://example.com/photo.png",
    });
  });

  test("falls back to Twitter metadata and document title without executing scripts", () => {
    const preview = readLinkPreviewMetadata(
      previewResponse(`<head>
      <script>throw new Error("untrusted"); '<meta property="og:title" content="Spoof">'</script>
      <title>A &lt;safe&gt; title</title>
      <meta name="twitter:description" content="Twitter description">
      </head>`),
    );
    expect(preview.title).toBe("A <safe> title");
    expect(preview.description).toBe("Twitter description");
    expect(preview.imageUrl).toBe("");
  });

  test.each([
    "http://127.0.0.1/private",
    "file:///etc/passwd",
    "https://user:pass@example.com/a",
    "data:image/png;base64,AAAA",
  ])("omits unsafe image candidate %s", (imageUrl) => {
    const preview = readLinkPreviewMetadata(
      previewResponse(
        `<head><meta property="og:image" content="${imageUrl}"></head>`,
      ),
    );
    expect(preview.imageUrl).toBe("");
  });

  test("bounds all upstream text and respects declared charset", () => {
    const preview = readLinkPreviewMetadata(
      previewResponse(`<head>
      <meta property="og:title" content="${"x".repeat(2_000)}">
      <meta property="og:description" content="${"x".repeat(2_000)}">
      <meta property="og:site_name" content="${"x".repeat(2_000)}"></head>`),
    );
    expect(preview.title).toHaveLength(200);
    expect(preview.description).toHaveLength(320);
    expect(preview.siteName).toHaveLength(80);
    const latin = readLinkPreviewMetadata(
      previewResponse("", {
        headers: { "content-type": "text/html; charset=windows-1252" },
        body: Buffer.from("<head><title>Café</title></head>", "latin1"),
      }),
    );
    expect(latin.title).toBe("Café");
  });
});

describe("preview raster boundary", () => {
  test("accepts a complete PNG with matching bytes", () => {
    expect(readPreviewRaster(pngResponse())).toMatchObject({
      contentType: "image/png",
    });
  });

  test("rejects SVG, HTML disguised as PNG, encoded and truncated images", () => {
    expect(
      readPreviewRaster(
        previewResponse("<svg/>", {
          headers: { "content-type": "image/svg+xml" },
        }),
      ),
    ).toBeNull();
    expect(
      readPreviewRaster(
        previewResponse("<script>1</script>", {
          headers: { "content-type": "image/png" },
        }),
      ),
    ).toBeNull();
    expect(
      readPreviewRaster({ ...pngResponse(), partialContent: true }),
    ).toBeNull();
    expect(
      readPreviewRaster({
        ...pngResponse(),
        headers: { "content-type": "image/png", "content-encoding": "gzip" },
      }),
    ).toBeNull();
  });
});
