import { afterEach, describe, expect, test, vi } from "vitest";
import { readLightConfig } from "../../../../plugins/web/source/light/config.js";
import { createLightTransport } from "../../../../plugins/web/source/light/crawl/transport.js";
import type {
  PublicHttpRequest,
  PublicHttpResponse,
} from "../../../../plugins/web/source/public-http.js";

const ORIGIN = "https://fixture.example";
const PAGE_URL = `${ORIGIN}/page`;
const ROBOTS_URL = `${ORIGIN}/robots.txt`;

afterEach(() => vi.useRealTimers());

function config() {
  return readLightConfig({
    sources: [
      {
        id: "fixture",
        title: "Fixture",
        description: "Fixture pages",
        keywords: ["fixture"],
        languages: ["en"],
        entryUrls: [PAGE_URL],
        allowedOrigins: [ORIGIN],
      },
    ],
  });
}

function response(
  url: string,
  text: string,
  headers: Record<string, string> = {},
): PublicHttpResponse {
  const body = Buffer.from(text);
  return {
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    headers,
    body,
    bytesRead: body.byteLength,
    partialContent: false,
  };
}

describe("Light robots response freshness and completeness", () => {
  test("refetches an aged cached policy before requesting a newly disallowed page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
    let policyVersion = 1;
    const get = vi.fn(async ({ url }: PublicHttpRequest) => {
      if (url !== ROBOTS_URL) return response(url, "page");
      const rules = policyVersion === 1 ? "Allow: /" : "Disallow: /";
      return response(url, `User-agent: *\n${rules}`, {
        "cache-control": "max-age=60",
        age: "59",
      });
    });
    const transport = createLightTransport({
      config: config(),
      httpClient: { get },
    });
    const first = transport.createSession();
    await first.get(PAGE_URL).finally(first.dispose);
    policyVersion = 2;
    vi.setSystemTime(Date.now() + 999);
    const cached = transport.createSession();
    await cached.get(PAGE_URL).finally(cached.dispose);
    expect(get.mock.calls.map(([request]) => request.url)).toEqual([
      ROBOTS_URL,
      PAGE_URL,
      PAGE_URL,
    ]);
    vi.setSystemTime(Date.now() + 1);
    const expired = transport.createSession();
    try {
      await expect(expired.get(PAGE_URL)).rejects.toMatchObject({
        code: "web_search_source_blocked",
      });
      expect(get.mock.calls.map(([request]) => request.url)).toEqual([
        ROBOTS_URL,
        PAGE_URL,
        PAGE_URL,
        ROBOTS_URL,
      ]);
    } finally {
      expired.dispose();
    }
  });

  test.each<{
    name: string;
    status: number;
    headers: Record<string, string>;
    partialContent: boolean;
  }>([
    { name: "HTTP 206", status: 206, headers: {}, partialContent: false },
    {
      name: "Content-Range on HTTP 200",
      status: 200,
      headers: { "content-range": "bytes 0-30/100" },
      partialContent: false,
    },
    {
      name: "transport truncation",
      status: 200,
      headers: {},
      partialContent: true,
    },
  ])(
    "blocks a page after $name without using a permissive prefix",
    async (partial) => {
      const get = vi.fn(async ({ url }: PublicHttpRequest) => ({
        ...response(url, "User-agent: *\nAllow: /", partial.headers),
        status: partial.status,
        partialContent: partial.partialContent,
      }));
      const session = createLightTransport({
        config: config(),
        httpClient: { get },
      }).createSession();
      try {
        await expect(session.get(PAGE_URL)).rejects.toMatchObject({
          code: "web_search_source_blocked",
        });
        expect(get.mock.calls.map(([request]) => request.url)).toEqual([
          ROBOTS_URL,
        ]);
      } finally {
        session.dispose();
      }
    },
  );

  test("blocks a robots body truncated by the remaining decoded limit", async () => {
    const get = vi.fn(async ({ url }: PublicHttpRequest) =>
      response(url, "User-agent: *\nAllow: /\nDisallow: /page"),
    );
    const session = createLightTransport({
      config: { ...config(), maxResponseBytes: 23 },
      httpClient: { get },
    }).createSession();
    try {
      await expect(session.get(PAGE_URL)).rejects.toMatchObject({
        code: "web_search_source_blocked",
      });
      expect(get.mock.calls.map(([request]) => request.url)).toEqual([
        ROBOTS_URL,
      ]);
      expect(session.snapshot().decodedBytes).toBe(23);
    } finally {
      session.dispose();
    }
  });
});
