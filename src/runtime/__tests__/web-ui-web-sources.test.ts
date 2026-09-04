import { describe, expect, test } from "vitest";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import {
  parseWebSourceUrl,
  webSourceFaviconUrl,
} from "../../web-ui/app/lib/source-url-policy.js";
import {
  buildConversationSources,
  normalizeLegacyWebSources,
  normalizeWebSources,
} from "../../web-ui/app/lib/web-sources.js";

const source = {
  url: "https://example.com/article?edition=1#section",
  title: "The article",
  retrieval: "retrieved",
  presentation: "content",
  contentTruncated: false,
};
const receipt = {
  version: 1,
  operation: "search",
  provider: "light",
  sources: [source],
};
const event = {
  requestId: "request-a",
  callId: "call-a",
  seqNo: 3,
  eventName: "tool.completed",
  tool: "web_search",
  webSources: receipt,
};

describe("web source URL policy", () => {
  test.each([
    "javascript:alert(1)",
    "data:image/svg+xml,test",
    "file:///etc/passwd",
    "mailto:a@example.com",
    "/relative",
    "//example.com/path",
    "https://user:password@example.com/path",
    "https://example.com/with\nnewline",
    `https://example.com/${"a".repeat(4_096)}`,
  ])("does not turn an unsafe source into a link: %s", (url) => {
    expect(parseWebSourceUrl(url)).toBeNull();
    expect(webSourceFaviconUrl(url)).toBe("");
  });

  test("preserves exact path, query and fragment while loading only the origin icon", () => {
    expect(parseWebSourceUrl(source.url)?.href).toBe(source.url);
    expect(webSourceFaviconUrl(source.url)).toBe(
      "https://example.com/favicon.ico",
    );
    expect(webSourceFaviconUrl("http://news.example.com:8080/article")).toBe(
      "http://news.example.com:8080/favicon.ico",
    );
  });

  test.each([
    "localhost",
    "localhost.",
    "app.localhost",
    "printer",
    "printer.local",
    "router.lan",
    "app.internal",
    "router.home",
    "127.0.0.1",
    "127.1",
    "2130706433",
    "0x7f000001",
    "10.0.0.1",
    "172.16.2.1",
    "192.168.1.1",
    "169.254.169.254",
    "[::1]",
    "[fc00::1]",
    "[fe80::1]",
    "[::ffff:127.0.0.1]",
  ])(
    "keeps links clickable without automatically requesting an icon from %s",
    (host) => {
      const url = `http://${host}/article`;
      expect(parseWebSourceUrl(url)).not.toBeNull();
      expect(webSourceFaviconUrl(url)).toBe("");
    },
  );
});

describe("web source receipt validation", () => {
  test("preserves omitted metadata counts separately from omitted tool output", () => {
    const value = {
      ...receipt,
      sources: [{ ...source, presentation: "omitted" }],
      omittedSourceCount: 24,
    };
    const normalized = normalizeWebSources(value, "web_search");
    expect(normalized?.sources[0]?.presentation).toBe("omitted");
    expect(normalized?.omittedSourceCount).toBe(24);
    expect(
      buildConversationSources([
        {
          ...event,
          webSources: { ...receipt, sources: [], omittedSourceCount: 25 },
        },
      ]),
    ).toHaveLength(1);
  });

  test.each([-1, 1.5, "2", 25, Infinity, null, undefined])(
    "rejects invalid or overflowing omitted metadata count %s",
    (omittedSourceCount) => {
      expect(
        normalizeWebSources({ ...receipt, omittedSourceCount }, "web_search"),
      ).toBeNull();
    },
  );

  test("ignores omitted metadata counts in legacy results", () => {
    const legacy = normalizeLegacyWebSources(
      { urls: [source.url], omittedSourceCount: 25 },
      "web_search",
    );
    expect(legacy).not.toHaveProperty("omittedSourceCount");
  });
  test("keeps presentation, retrieval, redirects and partial content independent", () => {
    const sources = [
      {
        ...source,
        requestedUrl: "https://example.com/old",
        contentTruncated: true,
      },
      { ...source, retrieval: "failed", presentation: "snippet" },
      { ...source, retrieval: "not_attempted", presentation: "reference" },
      { ...source, presentation: "omitted" },
    ];
    expect(normalizeWebSources({ ...receipt, sources }, "web_search")).toEqual({
      ...receipt,
      sources,
    });
  });

  test.each([
    [null, "web_search"],
    [{ ...receipt, version: 2 }, "web_search"],
    [{ ...receipt, version: 0 }, "web_search"],
    [{ ...receipt, operation: "fetch" }, "web_search"],
    [receipt, "exec"],
    [{ ...receipt, sources: {} }, "web_search"],
    [
      { ...receipt, sources: Array.from({ length: 26 }, () => source) },
      "web_search",
    ],
  ])("rejects an unsupported or malformed receipt", (value, toolName) => {
    expect(normalizeWebSources(value, toolName)).toBeNull();
  });

  test("bounds title text and excludes invalid entries without adding success claims", () => {
    const normalized = normalizeWebSources(
      {
        ...receipt,
        provider: "unknown",
        sources: [
          {
            ...source,
            title: "a".repeat(400),
            requestedUrl: "javascript:alert(1)",
          },
          { ...source, url: "https://u:p@example.com/" },
          { ...source, retrieval: "seen" },
          { ...source, presentation: "unknown" },
          { ...source, contentTruncated: "false" },
        ],
      },
      "web_search",
    );
    expect(normalized?.sources).toHaveLength(1);
    expect(normalized?.sources[0]?.title).toHaveLength(256);
    expect(normalized?.sources[0]).not.toHaveProperty("requestedUrl");
    expect(normalized).not.toHaveProperty("provider");
  });

  test.each(["failed", "not_attempted"])(
    "rejects a content-returned claim when retrieval was %s",
    (retrieval) => {
      const normalized = normalizeWebSources(
        { ...receipt, sources: [{ ...source, retrieval }] },
        "web_search",
      );
      expect(normalized?.sources).toEqual([]);
    },
  );
});

describe("legacy web source evidence", () => {
  test("labels search URLs with only exact recorded retrieval matches and no redirect pairing", () => {
    const original = "https://example.com/original";
    const fetched = "https://example.com/fetched";
    const partial = "https://example.com/partial";
    const normalized = normalizeLegacyWebSources(
      {
        urls: [original, fetched, partial],
        fetchedUrls: ["https://example.com/redirect-target", fetched],
        partialFetchedUrls: [partial],
        lightSearch: { provider: "light" },
      },
      "web_search",
    );
    expect(normalized).toMatchObject({ version: 0, provider: "light" });
    expect(normalized?.sources.map((item) => item.retrieval)).toEqual([
      "not_attempted",
      "retrieved",
      "retrieved",
    ]);
    expect(
      normalized?.sources.every((item) => item.presentation === "unknown"),
    ).toBe(true);
    expect(normalized?.sources.every((item) => !item.requestedUrl)).toBe(true);
    expect(normalized?.sources.map((item) => item.url)).toEqual([
      original,
      fetched,
      partial,
    ]);
  });

  test("restores old fetch URLs without claiming which text was returned", () => {
    const legacy = normalizeLegacyWebSources(
      { urls: [source.url] },
      "web_fetch",
    );
    expect(legacy).toEqual({
      version: 0,
      operation: "fetch",
      sources: [{ ...source, title: "example.com", presentation: "unknown" }],
    });
    expect(legacy).not.toHaveProperty("provider");
    expect(
      buildConversationSources([
        { ...event, tool: "web_fetch", webSources: legacy },
      ]),
    ).toHaveLength(1);
  });

  test("does not guess old sources from output text or unsupported metadata", () => {
    expect(
      normalizeLegacyWebSources({ output: source.url }, "web_search"),
    ).toBeNull();
    expect(
      normalizeLegacyWebSources({ urls: [source.url] }, "write_file"),
    ).toBeNull();
    expect(
      normalizeLegacyWebSources({ urls: ["javascript:alert(1)"] }, "web_search")
        ?.sources,
    ).toEqual([]);
  });
});

describe("source call projection", () => {
  test("uses original event sequence across transport replay numbering", () => {
    const original = { ...event, eventSequence: 2, seqNo: 20 };
    const replay = { ...event, eventSequence: 2, seqNo: 50 };
    const distinct = { ...event, eventSequence: 3, seqNo: 20 };
    const transportOnly = { ...event, seqNo: 2 };
    expect(
      buildConversationSources([original, replay, distinct, transportOnly]),
    ).toHaveLength(3);
  });

  test("keeps later calls when the Activity ring contains more than 100 completions", () => {
    const events = Array.from({ length: 101 }, (_, index) => ({
      ...event,
      callId: `call-${index}`,
      eventSequence: index + 1,
    }));
    const groups = buildConversationSources(events);
    expect(groups).toHaveLength(101);
    expect(groups.at(-1)?.callId).toBe("call-100");
  });

  test("deduplicates exact replay and retains outcomes of distinct calls to the same URL", () => {
    const differentCall = { ...event, callId: "call-b", seqNo: 4 };
    const laterResult = {
      ...event,
      callId: "call-c",
      seqNo: 5,
      webSources: {
        ...receipt,
        sources: [{ ...source, retrieval: "failed", presentation: "snippet" }],
      },
    };
    const groups = buildConversationSources([
      event,
      { ...event },
      differentCall,
      laterResult,
    ]);
    expect(groups.map((group) => group.callId)).toEqual([
      "call-a",
      "call-b",
      "call-c",
    ]);
    expect(groups.at(-1)?.sources[0]).toMatchObject({
      retrieval: "failed",
      presentation: "snippet",
    });
  });

  test("does not collapse unrelated calls with missing identity", () => {
    const withoutIdentity = { ...event, callId: undefined, seqNo: undefined };
    expect(
      buildConversationSources([withoutIdentity, withoutIdentity]),
    ).toHaveLength(2);
  });

  test("does not display sources on starts or failures and does not parse final prose", () => {
    expect(
      buildConversationSources([
        { ...event, eventName: "tool.started" },
        { ...event, eventName: "tool.failed" },
        { ...event, eventName: "request.completed" },
        { ...event, webSources: undefined, output: source.url },
      ]),
    ).toEqual([]);
  });

  test("keeps sources attached to the matching request before timeline grouping", () => {
    const model = buildConversationActivityModel({
      requestId: "request-a",
      events: [
        event,
        { ...event, requestId: "request-b" },
        { ...event, callId: "call-b", seqNo: 4 },
      ],
    });
    expect(model.sources).toHaveLength(2);
    expect(
      buildConversationActivityModel({
        requestId: "request-c",
        events: [event],
      }).sources,
    ).toEqual([]);
    expect(buildConversationActivityModel({ events: [event] }).sources).toEqual(
      [],
    );
  });
});
