import { afterEach, describe, expect, test, vi } from "vitest";
import { readLightConfig } from "../../../../plugins/web/source/light/config.js";
import { documentExpiresAt } from "../../../../plugins/web/source/light/documents/cache-policy.js";
import { createLightSearchService } from "../../../../plugins/web/source/light/search-service.js";
import type {
  PublicHttpRequest,
  PublicHttpResponse,
} from "../../../../plugins/web/source/public-http.js";

const NOW = Date.parse("2026-09-04T12:00:00Z");
const date = (offsetSeconds: number) =>
  new Date(NOW + offsetSeconds * 1_000).toUTCString();

afterEach(() => vi.useRealTimers());

function response(
  headers: Record<string, string> = {},
  url = "https://fixture.example/page",
): PublicHttpResponse {
  const body = Buffer.from(
    "<title>Fixture answer</title><p>Fixture answer evidence.</p>",
  );
  return {
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    headers: { "content-type": "text/html", ...headers },
    body,
    bytesRead: body.byteLength,
    partialContent: false,
  };
}

describe("Light HTTP cache freshness", () => {
  test.each<{
    name: string;
    headers: Record<string, string>;
    seconds: number;
  }>([
    { name: "expired Expires", headers: { expires: date(-1) }, seconds: 0 },
    {
      name: "Expires without Date",
      headers: { expires: date(60) },
      seconds: 60,
    },
    {
      name: "Expires with Date apparent age",
      headers: { date: date(-30), expires: date(30) },
      seconds: 30,
    },
    {
      name: "Expires with Age",
      headers: { date: date(-30), expires: date(30), age: "50" },
      seconds: 10,
    },
    {
      name: "already aged Expires",
      headers: { date: date(-30), expires: date(30), age: "60" },
      seconds: 0,
    },
    {
      name: "max-age overrides expired Expires",
      headers: { "cache-control": "max-age=60", expires: date(-1), age: "10" },
      seconds: 50,
    },
    {
      name: "max-age uses apparent Date age",
      headers: { "cache-control": "max-age=60", date: date(-59) },
      seconds: 1,
    },
    {
      name: "quoted max-age",
      headers: { "cache-control": 'max-age="60"', age: "59" },
      seconds: 1,
    },
    { name: "invalid Expires", headers: { expires: "invalid" }, seconds: 0 },
    { name: "Expires zero", headers: { expires: "0" }, seconds: 0 },
    {
      name: "invalid Age",
      headers: { "cache-control": "max-age=60", age: "invalid" },
      seconds: 0,
    },
    {
      name: "negative Age",
      headers: { "cache-control": "max-age=60", age: "-1" },
      seconds: 0,
    },
    {
      name: "malformed max-age",
      headers: { "cache-control": "max-age=60garbage" },
      seconds: 0,
    },
    {
      name: "duplicate max-age",
      headers: { "cache-control": "max-age=60,max-age=600" },
      seconds: 0,
    },
    {
      name: "no-store",
      headers: { "cache-control": "no-store", expires: date(60) },
      seconds: 0,
    },
  ])("honors $name", ({ headers, seconds }) => {
    expect(
      documentExpiresAt(
        response(headers),
        "page",
        readLightConfig(undefined),
        NOW,
      ),
    ).toBe(NOW + seconds * 1_000);
  });

  test("keeps the configured TTL cap and default when no explicit freshness is present", () => {
    const config = readLightConfig(undefined);
    const future = response({ expires: date(100_000) });
    expect(documentExpiresAt(future, "page", config, NOW)).toBe(
      NOW + config.pageTtlMs,
    );
    expect(documentExpiresAt(future, "feed", config, NOW)).toBe(
      NOW + config.feedTtlMs,
    );
    expect(documentExpiresAt(response(), "page", config, NOW)).toBe(
      NOW + config.pageTtlMs,
    );
  });

  test("refetches a document after its Expires freshness is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const get = vi.fn(async ({ url }: PublicHttpRequest) => {
      if (url.endsWith("/robots.txt"))
        return { ...response({}, url), status: 404 };
      return response({ date: date(0), expires: date(60), age: "59" }, url);
    });
    const service = createLightSearchService({
      httpClient: { get },
      config: {
        sources: [
          {
            id: "fixture",
            title: "Fixture",
            description: "Fixture pages",
            keywords: ["fixture"],
            languages: ["en"],
            entryUrls: ["https://fixture.example/page"],
            allowedOrigins: ["https://fixture.example"],
          },
        ],
      },
    });
    await service.search(["fixture"]);
    vi.setSystemTime(NOW + 999);
    const cached = await service.search(["fixture"]);
    expect(cached.lightSearch?.sources[0]?.cacheState).toBe("fresh_cache");
    vi.setSystemTime(NOW + 1_000);
    const fetched = await service.search(["fixture"]);
    expect(fetched.lightSearch?.sources[0]?.cacheState).toBe("fetched");
    expect(
      get.mock.calls.filter(([request]) => request.url.endsWith("/page")),
    ).toHaveLength(2);
  });
});
