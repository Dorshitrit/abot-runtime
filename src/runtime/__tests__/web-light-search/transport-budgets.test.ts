import { afterEach, describe, expect, test, vi } from "vitest";
import { readLightConfig } from "../../../../plugins/web/source/light/config.js";
import { createSessionBudget } from "../../../../plugins/web/source/light/crawl/session-budget.js";
import { createRobotsCache } from "../../../../plugins/web/source/light/crawl/robots-cache.js";
import { parseRobotsDocument } from "../../../../plugins/web/source/light/crawl/robots-parser.js";

afterEach(() => vi.useRealTimers());

describe("Light shared invocation resource budgets", () => {
  test("reserves concurrent response capacity before spending the same remaining bytes", () => {
    const budget = createSessionBudget({
      ...readLightConfig({}),
      maxResponseBytes: 100,
      maxTotalBytes: 150,
    });
    try {
      const first = budget.reserveRequest();
      const second = budget.reserveRequest();
      expect([first, second]).toEqual([100, 50]);
      expect(() => budget.reserveRequest()).toThrow(
        expect.objectContaining({ code: "web_search_budget_exhausted" }),
      );
      budget.completeRequest(40, first);
      budget.completeRequest(20, second);
      expect(budget.snapshot().bytes).toBe(60);
      expect(budget.canContinue()).toBe(false);
    } finally {
      budget.dispose();
    }
  });

  test("decoded data has its own aggregate cap without double charging identity bytes", () => {
    const budget = createSessionBudget({
      ...readLightConfig({}),
      maxTotalBytes: 100,
      maxResponseBytes: 100,
    });
    try {
      const reservation = budget.reserveRequest();
      budget.completeRequest(50, reservation);
      budget.consumeDecodedBytes(50);
      expect(budget.canContinue()).toBe(true);
      expect(budget.snapshot()).toMatchObject({ bytes: 50, decodedBytes: 50 });
      expect(() => budget.consumeDecodedBytes(51)).toThrow(
        expect.objectContaining({ code: "web_search_budget_exhausted" }),
      );
      expect(budget.snapshot().stopReason).toBe("byte_budget");
    } finally {
      budget.dispose();
    }
  });
});

describe("Light robots completed cache", () => {
  test("expires cached rules and never retains a zero-TTL document", () => {
    vi.useFakeTimers();
    const cache = createRobotsCache();
    const document = parseRobotsDocument("User-agent: *\nDisallow: /private");
    cache.set("https://a.example", document, 50);
    expect(cache.get("https://a.example")).toBe(document);
    vi.advanceTimersByTime(50);
    expect(cache.get("https://a.example")).toBeUndefined();
    cache.set("https://a.example", document, 0);
    expect(cache.get("https://a.example")).toBeUndefined();
  });

  test("evicts least recently used origins at the bounded entry limit", () => {
    const cache = createRobotsCache();
    const document = parseRobotsDocument("User-agent: *\nDisallow: /private");
    for (let index = 0; index < 64; index += 1) {
      cache.set(`https://${index}.example`, document, 50_000);
    }
    cache.get("https://0.example");
    cache.set("https://new.example", document, 50_000);
    expect(cache.get("https://0.example")).toBe(document);
    expect(cache.get("https://1.example")).toBeUndefined();
    expect(cache.get("https://new.example")).toBe(document);
  });
});
