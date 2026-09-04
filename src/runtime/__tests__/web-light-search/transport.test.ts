import { afterEach, describe, expect, test, vi } from "vitest";
import {
  readLightConfig,
  type LightConfig,
} from "../../../../plugins/web/source/light/config.js";
import { createLightTransport } from "../../../../plugins/web/source/light/crawl/transport.js";
import {
  createPublicHttpClient,
  type PublicHttpRequest,
  type PublicHttpResponse,
} from "../../../../plugins/web/source/public-http.js";
import { WebPluginError } from "../../../../plugins/web/source/errors.js";

// Match the existing public HTTP test fixture; requestHop is always stubbed.
const EXAMPLE_PUBLIC_IPV4 = [93, 184, 216, 34].join(".");

afterEach(() => vi.useRealTimers());

function config(overrides: Partial<LightConfig> = {}): LightConfig {
  return {
    ...readLightConfig({
      sources: [
        {
          id: "fixture",
          title: "Fixture",
          description: "Fixture pages",
          keywords: ["fixture"],
          languages: ["en"],
          entryUrls: ["https://a.example/page"],
          allowedOrigins: [
            "https://a.example",
            "https://b.example",
            "https://c.example",
            "https://d.example",
          ],
        },
      ],
    }),
    ...overrides,
  };
}

function response(
  url: string,
  status = 200,
  text = "page",
  headers: Record<string, string> = {},
): PublicHttpResponse {
  const body = Buffer.from(text);
  return {
    requestedUrl: url,
    finalUrl: url,
    status,
    headers: { "content-type": "text/plain", ...headers },
    body,
    bytesRead: body.length,
    partialContent: false,
  };
}

describe("Light bounded direct-origin transport", () => {
  test("public client opt-out returns one redirect without changing default redirect behavior", async () => {
    const hop = vi.fn(async ({ url }: { url: URL }) => {
      const result =
        url.pathname === "/start"
          ? response(url.href, 302, "", { location: "/final" })
          : response(url.href);
      return result;
    });
    const client = createPublicHttpClient({
      resolveHost: async () => [{ address: EXAMPLE_PUBLIC_IPV4, family: 4 }],
      requestHop: hop,
    });
    const first = await client.get({
      url: "https://a.example/start",
      followRedirects: false,
    });
    expect(first.status).toBe(302);
    expect(hop).toHaveBeenCalledTimes(1);
    const followed = await client.get({ url: "https://a.example/start" });
    expect(followed.finalUrl).toBe("https://a.example/final");
    expect(hop).toHaveBeenCalledTimes(3);
  });

  test("checks redirected page robots before sending the forbidden hop", async () => {
    const seen: string[] = [];
    const get = vi.fn(async ({ url }: PublicHttpRequest) => {
      seen.push(url);
      if (url === "https://a.example/robots.txt") return response(url, 404, "");
      if (url === "https://b.example/robots.txt")
        return response(url, 200, "User-agent: *\nDisallow: /private");
      return response(url, 302, "", { location: "https://b.example/private" });
    });
    const session = createLightTransport({
      config: config(),
      httpClient: { get },
    }).createSession();
    try {
      await expect(
        session.get("https://a.example/start"),
      ).rejects.toMatchObject({ code: "web_search_source_blocked" });
      expect(seen).toEqual([
        "https://a.example/robots.txt",
        "https://a.example/start",
        "https://b.example/robots.txt",
      ]);
      expect(session.snapshot().requests).toBe(3);
    } finally {
      session.dispose();
    }
  });

  test("robots may redirect across public origins without admitting those origins for pages", async () => {
    const get = vi.fn(async ({ url }: PublicHttpRequest) => {
      if (url === "https://a.example/robots.txt")
        return response(url, 302, "", {
          location: "https://robots.example/policy",
        });
      if (url === "https://robots.example/policy") {
        return response(
          url,
          200,
          "User-agent: *\nAllow: /\nSitemap: https://robots.example/map.xml\nSitemap: https://a.example/map.xml",
        );
      }
      return response(url, 302, "", {
        location: "https://robots.example/article",
      });
    });
    const session = createLightTransport({
      config: config(),
      httpClient: { get },
    }).createSession();
    try {
      await expect(
        session.get("https://a.example/start"),
      ).rejects.toMatchObject({ code: "web_search_source_blocked" });
      expect(get.mock.calls.map(([request]) => request.url)).not.toContain(
        "https://robots.example/article",
      );
      expect(session.sitemapsFor("https://a.example")).toEqual([
        "https://a.example/map.xml",
      ]);
    } finally {
      session.dispose();
    }
  });

  test.each([401, 403, 429, 503])(
    "robots HTTP %i prevents a page request",
    async (status) => {
      const get = vi.fn(async ({ url }: PublicHttpRequest) =>
        response(url, status, ""),
      );
      const session = createLightTransport({
        config: config(),
        httpClient: { get },
      }).createSession();
      try {
        await expect(
          session.get("https://a.example/page"),
        ).rejects.toMatchObject({ code: "web_search_source_blocked" });
        expect(get).toHaveBeenCalledTimes(1);
      } finally {
        session.dispose();
      }
    },
  );

  test("request budget counts robots and redirect hops", async () => {
    const get = vi.fn(async ({ url }: PublicHttpRequest) =>
      response(url, 404, ""),
    );
    const session = createLightTransport({
      config: config({ maxRequests: 1 }),
      httpClient: { get },
    }).createSession();
    try {
      await expect(session.get("https://a.example/page")).rejects.toMatchObject(
        { code: "web_search_budget_exhausted" },
      );
      expect(session.snapshot()).toMatchObject({
        requests: 1,
        stopReason: "request_budget",
      });
    } finally {
      session.dispose();
    }
  });

  test("uses invocation soft and hard deadlines and keeps user abort distinct", async () => {
    vi.useFakeTimers();
    const transport = createLightTransport({
      config: config({ softTimeoutMs: 20, hardTimeoutMs: 30 }),
      httpClient: { get: async ({ url }) => response(url, 404, "") },
    });
    const session = transport.createSession();
    const controller = new AbortController();
    const other = transport.createSession(controller.signal);
    await vi.advanceTimersByTimeAsync(20);
    expect(session.canContinue()).toBe(false);
    expect(() => session.assertActive()).not.toThrow();
    controller.abort();
    expect(() => other.assertActive()).toThrow(
      expect.objectContaining({ code: "web_request_aborted" }),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(() => session.assertActive()).toThrow(
      expect.objectContaining({ code: "web_request_timed_out" }),
    );
    session.dispose();
    other.dispose();
  });

  test("stops new robots redirect hops at the soft deadline without caching a denial", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let firstAttempt = true;
    const get = vi.fn(async ({ url }: PublicHttpRequest) => {
      if (firstAttempt) {
        firstAttempt = false;
        vi.setSystemTime(25);
        return response(url, 302, "", { location: "/redirected-robots" });
      }
      return response(url, url.endsWith("/robots.txt") ? 404 : 200, "");
    });
    const transport = createLightTransport({
      config: config({ softTimeoutMs: 20, hardTimeoutMs: 100 }),
      httpClient: { get },
    });
    const first = transport.createSession();
    try {
      await expect(first.get("https://a.example/page")).rejects.toMatchObject({
        code: "web_search_budget_exhausted",
      });
      expect(first.snapshot()).toMatchObject({
        requests: 1,
        stopReason: "time_budget",
      });
      expect(get.mock.calls.map(([request]) => request.url)).toEqual([
        "https://a.example/robots.txt",
      ]);
      expect(() => first.assertActive()).not.toThrow();
    } finally {
      first.dispose();
    }
    const second = transport.createSession();
    try {
      await expect(second.get("https://a.example/page")).resolves.toMatchObject(
        { status: 200 },
      );
      expect(get.mock.calls.map(([request]) => request.url)).toEqual([
        "https://a.example/robots.txt",
        "https://a.example/robots.txt",
        "https://a.example/page",
      ]);
    } finally {
      second.dispose();
    }
  });

  test("shares global and origin capacity across sessions", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maximum = 0;
    let sameOriginMaximum = 0;
    const perOrigin = new Map<string, number>();
    const get = async ({ url }: PublicHttpRequest) => {
      const origin = new URL(url).origin;
      active += 1;
      perOrigin.set(origin, (perOrigin.get(origin) ?? 0) + 1);
      maximum = Math.max(maximum, active);
      sameOriginMaximum = Math.max(sameOriginMaximum, perOrigin.get(origin)!);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      perOrigin.set(origin, perOrigin.get(origin)! - 1);
      return response(url, url.endsWith("/robots.txt") ? 404 : 200, "");
    };
    const transport = createLightTransport({
      config: config(),
      httpClient: { get },
    });
    const sessions = Array.from({ length: 5 }, () => transport.createSession());
    const urls = ["a", "a", "b", "c", "d"].map(
      (host) => `https://${host}.example/page`,
    );
    const pending = Promise.all(
      sessions.map((session, index) =>
        session.get(urls[index]!).finally(session.dispose),
      ),
    );
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(maximum).toBe(3);
    expect(sameOriginMaximum).toBe(1);
  });

  test("one aborted session never supplies a failed in-flight robots promise to another", async () => {
    const get = vi.fn(async ({ url, abortSignal }: PublicHttpRequest) => {
      if (get.mock.calls.length === 1) {
        await new Promise((_, reject) =>
          abortSignal?.addEventListener(
            "abort",
            () =>
              reject(new WebPluginError("web_request_aborted", "cancelled")),
            { once: true },
          ),
        );
      }
      return response(url, url.endsWith("/robots.txt") ? 404 : 200, "");
    });
    const transport = createLightTransport({
      config: config(),
      httpClient: { get },
    });
    const controller = new AbortController();
    const first = transport.createSession(controller.signal);
    const second = transport.createSession();
    const cancelled = first.get("https://a.example/page");
    const rejected = expect(cancelled).rejects.toMatchObject({
      code: "web_request_aborted",
    });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    const successful = second.get("https://a.example/page");
    controller.abort();
    await rejected;
    await expect(successful).resolves.toMatchObject({ status: 200 });
    expect(
      get.mock.calls.filter(([request]) => request.url.endsWith("/robots.txt")),
    ).toHaveLength(2);
    first.dispose();
    second.dispose();
  });
});
