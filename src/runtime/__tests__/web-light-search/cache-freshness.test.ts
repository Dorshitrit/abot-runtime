import { afterEach, expect, test, vi } from "vitest";
import { createLightSearchService } from "../../../../plugins/web/source/light/search-service.js";
import type {
  PublicHttpRequest,
  PublicHttpResponse,
} from "../../../../plugins/web/source/public-http.js";

afterEach(() => vi.useRealTimers());

function pageResponse(
  url: string,
  text: string,
  cacheControl: string,
  status = 200,
): PublicHttpResponse {
  const body = Buffer.from(text);
  return {
    requestedUrl: url,
    finalUrl: url,
    status,
    headers: { "content-type": "text/html", "cache-control": cacheControl },
    body,
    bytesRead: body.byteLength,
    partialContent: false,
  };
}

test("omits cache records that expire during collection while retaining a live no-store response", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let searchRound = 1;
  const get = async ({
    url,
  }: PublicHttpRequest): Promise<PublicHttpResponse> => {
    if (url.endsWith("/robots.txt"))
      return pageResponse(url, "", "max-age=86400", 404);
    if (url === "https://cached.example/page") {
      return pageResponse(
        url,
        "<title>Fixture cached answer</title><p>Fixture cached answer evidence.</p>",
        "max-age=1",
      );
    }
    if (searchRound === 2) vi.setSystemTime(1_500);
    return pageResponse(
      url,
      "<title>Fixture current answer</title><p>Fixture current live answer evidence.</p>",
      "no-store",
    );
  };
  const sources = [
    ["cached", "https://cached.example"],
    ["current", "https://current.example"],
  ].map(([id, origin]) => ({
    id,
    title: "Fixture source",
    description: "Fixture source pages",
    keywords: ["fixture"],
    languages: ["en"],
    entryUrls: [origin + "/page"],
    allowedOrigins: [origin],
  }));
  const service = createLightSearchService({
    httpClient: { get },
    config: { sources, sourceLimit: 2 },
  });
  const first = await service.search(["fixture"]);
  expect(first.hits.map(({ url }) => url)).toContain(
    "https://cached.example/page",
  );
  searchRound = 2;
  vi.setSystemTime(500);
  const second = await service.search(["fixture"]);
  expect(second.hits.map(({ url }) => url)).toEqual([
    "https://current.example/page",
  ]);
  expect(second.lightSearch?.cache.staleServed).toBe(0);
  expect(second.lightSearch?.sources).toEqual([
    expect.objectContaining({
      url: "https://current.example/page",
      cacheState: "fetched",
      fetchedAt: new Date(1_500).toISOString(),
    }),
  ]);
});
