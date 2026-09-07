import { createServer } from "node:http";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createLinkPreviewRouteHandler } from "../../../web-ui/link-preview/routes.js";
import type { LinkPreviewService } from "../../../web-ui/link-preview/service.js";

const shutdown: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(shutdown.splice(0).map((close) => close()));
});

async function servePreviewRoutes(
  service: LinkPreviewService,
): Promise<string> {
  const handle = createLinkPreviewRouteHandler(service);
  const server = createServer((request, response) => {
    void handle(request, response).then((handled) => {
      if (handled) return;
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  shutdown.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  return `http://127.0.0.1:${address.port}`;
}

const preview = {
  url: "https://example.com/page",
  title: "<strong>Title</strong>",
  description: "Description",
  imageUrl: "/web-link-preview/image?id=known",
  siteName: "Example",
};

describe("same-origin preview routes", () => {
  test("returns metadata only for explicit same-origin preview GETs", async () => {
    const getPreview = vi
      .fn<LinkPreviewService["getPreview"]>()
      .mockResolvedValue(preview);
    const origin = await servePreviewRoutes({
      getPreview,
      getImage: async () => null,
    });
    const response = await fetch(
      `${origin}/web-link-preview?url=https%3A%2F%2Fexample.com%2Fpage`,
      {
        headers: {
          "X-Abot-Link-Preview": "1",
          "Sec-Fetch-Site": "same-origin",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, preview });
    expect(getPreview).toHaveBeenCalledWith("https://example.com/page");
  });

  test.each<{ label: string; headers: Record<string, string> }>([
    {
      label: "cross-site",
      headers: { "X-Abot-Link-Preview": "1", "Sec-Fetch-Site": "cross-site" },
    },
    {
      label: "same-site",
      headers: { "X-Abot-Link-Preview": "1", "Sec-Fetch-Site": "same-site" },
    },
    { label: "missing opt-in", headers: { "Sec-Fetch-Site": "same-origin" } },
    { label: "missing provenance", headers: { "X-Abot-Link-Preview": "1" } },
    {
      label: "foreign referer",
      headers: { "X-Abot-Link-Preview": "1", Referer: "https://evil.example/" },
    },
  ])("rejects $label before any remote fetch", async ({ headers }) => {
    const getPreview = vi.fn<LinkPreviewService["getPreview"]>();
    const origin = await servePreviewRoutes({
      getPreview,
      getImage: async () => null,
    });
    const response = await fetch(
      `${origin}/web-link-preview?url=https://example.com`,
      { headers },
    );
    expect(response.status).toBe(403);
    expect(getPreview).not.toHaveBeenCalled();
  });

  test("supports same-origin referers when Fetch Metadata is unavailable", async () => {
    const origin = await servePreviewRoutes({
      getPreview: async () => preview,
      getImage: async () => null,
    });
    const response = await fetch(
      `${origin}/web-link-preview?url=https://example.com`,
      {
        headers: { "X-Abot-Link-Preview": "1", Referer: `${origin}/` },
      },
    );
    expect(response.status).toBe(200);
  });

  test("does not accept non-GET requests or expose failed upstream details", async () => {
    const getPreview = vi
      .fn<LinkPreviewService["getPreview"]>()
      .mockResolvedValue(null);
    const origin = await servePreviewRoutes({
      getPreview,
      getImage: async () => null,
    });
    const path = `${origin}/web-link-preview?url=https://example.com`;
    const post = await fetch(path, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin", "X-Abot-Link-Preview": "1" },
    });
    expect(post.status).toBe(405);
    expect(getPreview).not.toHaveBeenCalled();
    const unavailable = await fetch(path, {
      headers: { "Sec-Fetch-Site": "same-origin", "X-Abot-Link-Preview": "1" },
    });
    expect(await unavailable.json()).toEqual({
      ok: false,
      error: "preview_unavailable",
    });
  });

  test("serves approved image bytes with restrictive response headers and rejects unknown tokens", async () => {
    const body = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const getImage = vi
      .fn<LinkPreviewService["getImage"]>()
      .mockResolvedValueOnce({ contentType: "image/png", body })
      .mockResolvedValue(null);
    const origin = await servePreviewRoutes({
      getPreview: async () => null,
      getImage,
    });
    const response = await fetch(`${origin}/web-link-preview/image?id=known`, {
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
    expect(getImage).toHaveBeenCalledWith("known");
    const missing = await fetch(`${origin}/web-link-preview/image?id=unknown`, {
      headers: { Referer: `${origin}/` },
    });
    expect(missing.status).toBe(404);
    const unrelated = await fetch(`${origin}/unrelated`);
    expect(unrelated.status).toBe(404);
  });
});
