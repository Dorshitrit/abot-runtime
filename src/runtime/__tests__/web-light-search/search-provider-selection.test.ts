import { describe, expect, test, vi } from "vitest";

import type { RuntimePluginLoadContext } from "../../../plugin-sdk/index.js";
import { WEB_LIMITS } from "../../../../plugins/web/source/limits.js";
import { parseSearchParams } from "../../../../plugins/web/source/parameters.js";
import { createWebPlugin } from "../../../../plugins/web/source/plugin.js";
import type { PublicHttpRequest } from "../../../../plugins/web/source/public-http.js";
import {
  article,
  feed,
  fixtureContext,
  fixtureHttp,
  fixtureResponse,
  fixtureSource,
} from "./search-fixture.js";

function providerContext(
  apiKey: string,
  light: unknown,
): RuntimePluginLoadContext {
  return {
    ...fixtureContext(light),
    secrets: {
      get: (name) => (name === "braveSearchApiKey" ? apiKey : undefined),
    },
  };
}

describe("Web search provider selection and compatibility", () => {
  test.each([
    [401, "web_search_authentication_failed", 1],
    [403, "web_search_authentication_failed", 1],
    [429, "web_search_rate_limited", WEB_LIMITS.retryAttempts + 1],
    [503, "web_search_upstream_failed", 1],
  ] as const)(
    "preserves Brave HTTP %i without attempting Light",
    async (status, errorCode, attempts) => {
      const apiKey = "configured-brave-secret";
      const get = vi.fn(async ({ url }: PublicHttpRequest) =>
        fixtureResponse(url, JSON.stringify({ detail: `rejected ${apiKey}` }), {
          status,
          contentType: "application/json",
        }),
      );
      const plugin = createWebPlugin(
        providerContext(` ${apiKey} `, { sources: [] }),
        {
          httpClient: { get },
        },
      );

      const result = await plugin.handlers.web_search!({
        query: "current release",
      });

      expect(result).toMatchObject({
        ok: false,
        errorCode,
        producedNewInformation: false,
      });
      expect(get).toHaveBeenCalledTimes(attempts);
      for (const [request] of get.mock.calls) {
        expect(new URL(request.url).origin).toBe(
          "https://api.search.brave.com",
        );
        expect(request.headers?.["X-Subscription-Token"]).toBe(apiKey);
      }
      expect(JSON.stringify(result)).not.toContain(apiKey);
    },
  );

  test("does not validate unused Light settings on successful Brave search", async () => {
    const get = vi.fn(async ({ url }: PublicHttpRequest) =>
      fixtureResponse(url, JSON.stringify({ web: { results: [] } }), {
        contentType: "application/json",
      }),
    );
    const plugin = createWebPlugin(
      providerContext("brave-key", { unsupportedLightSetting: true }),
      {
        httpClient: { get },
      },
    );

    const result = await plugin.handlers.web_search!({
      query: "current release",
    });

    expect(result).toMatchObject({
      ok: true,
      producedNewInformation: false,
      data: { hasData: false },
    });
    expect(get).toHaveBeenCalledOnce();
    expect(new URL(get.mock.calls[0]![0].url).hostname).toBe(
      "api.search.brave.com",
    );
    expect(result.data?.eventMeta).not.toHaveProperty("lightSearch");
  });

  test("selects Light for a whitespace-only key and discovers source content", async () => {
    const source = fixtureSource("provider-selection", "astronomy");
    const discoveredUrl = "https://provider-selection.example/observation";
    const fixture = fixtureHttp(({ url }) => {
      if (url === source.entryUrls[0])
        return fixtureResponse(
          url,
          feed([{ title: "Astronomy observation", url: discoveredUrl }]),
          { contentType: "application/rss+xml" },
        );
      return fixtureResponse(
        url,
        article(
          "Astronomy observation",
          "Astronomy evidence from a public observation.",
        ),
      );
    });
    const plugin = createWebPlugin(
      providerContext(" \t\n ", { sources: [source] }),
      fixture,
    );

    const result = await plugin.handlers.web_search!({
      query: "astronomy observation",
    });

    expect(result).toMatchObject({
      ok: true,
      producedNewInformation: true,
      data: {
        eventMeta: {
          urls: [discoveredUrl],
          lightSearch: { provider: "light" },
        },
      },
    });
    expect(
      fixture.requests.every(
        ({ url }) => new URL(url).origin === source.allowedOrigins[0],
      ),
    ).toBe(true);
    expect(
      fixture.requests.some(
        ({ headers }) => headers?.["X-Subscription-Token"] !== undefined,
      ),
    ).toBe(false);
  });

  test("defers invalid Light configuration until search and preserves URL fetching", async () => {
    const get = vi.fn(async ({ url }: PublicHttpRequest) =>
      fixtureResponse(
        url,
        article(
          "Direct page",
          "Direct URL fetching remains available without search configuration.",
        ),
      ),
    );
    const plugin = createWebPlugin(providerContext("", { sources: [] }), {
      httpClient: { get },
    });

    const fetched = await plugin.handlers.web_fetch!({
      url: "https://example.com/page",
    });
    expect(fetched).toMatchObject({
      ok: true,
      data: { hasData: true, itemCount: 1 },
    });
    expect(get).toHaveBeenCalledOnce();

    const searched = await plugin.handlers.web_search!({
      query: "current release",
    });
    expect(searched).toMatchObject({
      ok: false,
      errorCode: "web_search_configuration_invalid",
      producedNewInformation: false,
    });
    expect(get).toHaveBeenCalledOnce();
  });
});

describe.each(["", "configured-brave-key"])(
  "search parameter boundary for key %j",
  (apiKey) => {
    test.each([
      { query: "one", queries: ["two"] },
      { query: " \t " },
      { query: "q".repeat(401) },
      { query: Array.from({ length: 51 }, () => "q").join(" ") },
      { queries: ["one", "two", "three", "four", "five", "six"] },
      { queries: [] },
      { query: "one", unsupported: true },
    ])("rejects invalid parameters before provider work %#", async (params) => {
      const get = vi.fn();
      const plugin = createWebPlugin(providerContext(apiKey, { sources: [] }), {
        httpClient: { get },
      });

      const issue = plugin.adapters?.web_search?.validateCall?.({
        tool: "web_search",
        params,
      });
      expect(issue).toMatchObject({ error: expect.any(String) });
      const result = await plugin.handlers.web_search!(params);
      expect(result).toMatchObject({
        ok: false,
        producedNewInformation: false,
      });
      expect(result.errorCode).not.toBe("web_search_configuration_invalid");
      expect(get).not.toHaveBeenCalled();
    });
  },
);

test("retains accepted query normalization and public upper bounds", () => {
  expect(parseSearchParams({ query: " current release " })).toEqual([
    "current release",
  ]);
  expect(parseSearchParams({ query: "q".repeat(400) })).toEqual([
    "q".repeat(400),
  ]);
  const maximumWords = Array.from({ length: 50 }, () => "q").join(" ");
  expect(parseSearchParams({ query: maximumWords })).toEqual([maximumWords]);
  expect(
    parseSearchParams({ queries: ["one", "two", "three", "four", "five"] }),
  ).toHaveLength(5);
});
