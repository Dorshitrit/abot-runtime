import { describe, expect, test, vi } from "vitest";

import {
  createPublicHttpClient,
  type PublicHttpClient,
} from "../../../shared/public-http/public-http.js";
import { createLinkPreviewService } from "../../../web-ui/link-preview/service.js";
import { pngResponse, previewResponse } from "./preview-fixtures.js";

const EXAMPLE_PUBLIC_IPV4 = [93, 184, 216, 34].join(".");

function imageId(imageUrl: string): string {
  return new URL(imageUrl, "http://localhost").searchParams.get("id")!;
}

describe("link preview service", () => {
  test("deduplicates URL fragments and pending requests, then expires successes", async () => {
    let now = 0;
    let finish!: (value: ReturnType<typeof previewResponse>) => void;
    const get = vi.fn<PublicHttpClient["get"]>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const service = createLinkPreviewService({
      httpClient: { get },
      now: () => now,
    });
    const first = service.getPreview("https://example.com/page#one");
    const second = service.getPreview("https://example.com/page#two");
    expect(get).toHaveBeenCalledOnce();
    finish(previewResponse());
    expect(await first).toEqual(await second);
    await service.getPreview("https://example.com/page");
    expect(get).toHaveBeenCalledOnce();
    now += 300_001;
    get.mockResolvedValue(previewResponse());
    await service.getPreview("https://example.com/page");
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("caches unavailable responses briefly and bounds cache entries", async () => {
    let now = 0;
    const get = vi
      .fn<PublicHttpClient["get"]>()
      .mockRejectedValue(new Error("secret upstream detail"));
    const service = createLinkPreviewService({
      httpClient: { get },
      now: () => now,
    });
    expect(await service.getPreview("https://example.com/0")).toBeNull();
    expect(await service.getPreview("https://example.com/0")).toBeNull();
    expect(get).toHaveBeenCalledOnce();
    now = 60_001;
    get.mockResolvedValue(previewResponse());
    await service.getPreview("https://example.com/0");
    expect(get).toHaveBeenCalledTimes(2);
    for (let index = 1; index <= 64; index += 1)
      await service.getPreview(`https://example.com/${index}`);
    await service.getPreview("https://example.com/0");
    expect(get).toHaveBeenCalledTimes(67);
  });

  test("bounds simultaneous fetches without admitting an unbounded queue", async () => {
    const releases: Array<() => void> = [];
    const get = vi.fn<PublicHttpClient["get"]>(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(previewResponse()));
        }),
    );
    const service = createLinkPreviewService({ httpClient: { get } });
    const pending = Array.from({ length: 12 }, (_, index) =>
      service.getPreview(`https://example.com/${index}`),
    );
    expect(get).toHaveBeenCalledTimes(8);
    for (const release of releases) release();
    const results = await Promise.all(pending);
    expect(results.filter(Boolean)).toHaveLength(8);
  });

  test("returns opaque local images and reuses the same bounded transport", async () => {
    const get = vi
      .fn<PublicHttpClient["get"]>()
      .mockResolvedValueOnce(
        previewResponse(
          '<head><title>Card</title><meta property="og:image" content="/image.png"></head>',
        ),
      )
      .mockResolvedValue(pngResponse());
    const service = createLinkPreviewService({ httpClient: { get } });
    const preview = await service.getPreview("https://example.com/page");
    expect(preview?.imageUrl).toMatch(
      /^\/web-link-preview\/image\?id=[\w-]+$/u,
    );
    const id = imageId(preview!.imageUrl);
    expect(await service.getImage(id)).toMatchObject({
      contentType: "image/png",
    });
    await service.getImage(id);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1]![0]).toMatchObject({
      url: "https://example.com/image.png",
      maxBytes: 1024 * 1024,
      timeoutMs: 8_000,
      maxRedirects: 3,
    });
    expect(get.mock.calls[1]![0].headers).not.toHaveProperty("Cookie");
    expect(await service.getImage("https://example.com/arbitrary")).toBeNull();
  });

  test("supports direct raster links and expires their image tokens", async () => {
    let now = 0;
    const get = vi
      .fn<PublicHttpClient["get"]>()
      .mockResolvedValue(pngResponse());
    const service = createLinkPreviewService({
      httpClient: { get },
      now: () => now,
    });
    const preview = await service.getPreview("https://example.com/image.png");
    const id = imageId(preview!.imageUrl);
    expect(await service.getImage(id)).toMatchObject({
      contentType: "image/png",
    });
    expect(get).toHaveBeenCalledOnce();
    now = 300_001;
    expect(await service.getImage(id)).toBeNull();
  });

  test.each([
    "http://localhost/x",
    "http://127.0.0.1/x",
    "http://[::1]/x",
    "https://user:pass@example.com/x",
    "file:///tmp/private",
    " https://example.com/space",
    "https://example.com/line\nbreak",
  ])("rejects forbidden metadata URL %s before transport", async (url) => {
    const get = vi.fn<PublicHttpClient["get"]>();
    expect(
      await createLinkPreviewService({ httpClient: { get } }).getPreview(url),
    ).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  test("blocks redirect rebinding and image hosts resolving to private addresses", async () => {
    const requested: string[] = [];
    const client = createPublicHttpClient({
      resolveHost: async (hostname) => [
        {
          address:
            hostname === "private.example" ? "127.0.0.1" : EXAMPLE_PUBLIC_IPV4,
          family: 4,
        },
      ],
      requestHop: async ({ url }) => {
        requested.push(url.toString());
        if (url.pathname === "/redirect")
          return previewResponse("", {
            status: 302,
            headers: { location: "http://private.example/private" },
          });
        return previewResponse(
          '<head><meta property="og:image" content="https://private.example/image.png"></head>',
        );
      },
    });
    const service = createLinkPreviewService({ httpClient: client });
    expect(await service.getPreview("https://example.com/redirect")).toBeNull();
    const preview = await service.getPreview("https://example.com/page");
    expect(await service.getImage(imageId(preview!.imageUrl))).toBeNull();
    expect(requested).toEqual([
      "https://example.com/redirect",
      "https://example.com/page",
    ]);
  });

  test.each([
    previewResponse("", { status: 404 }),
    previewResponse("plain text", {
      headers: { "content-type": "text/plain" },
    }),
    previewResponse("encoded", {
      headers: { "content-type": "text/html", "content-encoding": "gzip" },
    }),
  ])(
    "degrades unsupported upstream responses to an unavailable preview",
    async (response) => {
      const service = createLinkPreviewService({
        httpClient: { get: async () => response },
      });
      expect(await service.getPreview("https://example.com/page")).toBeNull();
    },
  );
});
