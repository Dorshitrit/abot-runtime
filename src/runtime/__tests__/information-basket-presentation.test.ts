import { expect, test, vi } from "vitest";
import type { BasketSearchResult } from "../information-basket/contracts.js";
import { basketSearchSummary, basketSourceDisplayName, emitBasketDiscovery } from "../information-basket/presentation.js";

test("display summaries bound names and omit source bodies, paths, queries, and raw failures", () => {
  const result: BasketSearchResult = { status: "found", omittedCount: 2, sources: Array.from({ length: 8 },
    (_, index) => ({ sourceId: "source-" + index, expectedRevision: 1,
      displayName: index === 0 ? "FIRST\u0000\u202e\n" + "x".repeat(200) : "NAME_" + index,
      path: "/PRIVATE_PATH", score: 0.8, excerpt: "PRIVATE_BODY",
      matches: [{ chunkId: "chunk-0", startChar: 0, endChar: 1 }] })) };
  const summary = basketSearchSummary(result);
  expect(summary).toContain("Found 8 relevant information basket sources");
  expect(summary).toContain("3 additional source names omitted");
  expect(summary).toContain("2 further matches omitted");
  expect(summary).toContain("NAME_4");
  expect(summary).not.toContain("NAME_5");
  expect(summary).not.toMatch(/PRIVATE_|[\p{Cc}\p{Cf}]/u);
  expect(Array.from(basketSourceDisplayName(result.sources[0]!.displayName))).toHaveLength(120);
  expect(basketSourceDisplayName("\u0000\u202e")).toBe("Unnamed source");

  const target = { onEvent: vi.fn() };
  emitBasketDiscovery(target, result);
  const events = JSON.stringify(target.onEvent.mock.calls);
  expect(events).not.toMatch(/PRIVATE_|source-0|chunk-0/);
  expect(target.onEvent.mock.calls[0]).toEqual(["runtime.state", {
    stage: "information_basket", phase: "discovery_found", message: summary,
  }]);
});

test("unavailable search is distinct from an empty search and optional discovery stays silent", () => {
  const target = { onEvent: vi.fn() };
  const unavailable: BasketSearchResult = { status: "unavailable", sources: [], omittedCount: 0, reason: "PRIVATE_REASON" };
  emitBasketDiscovery(target, unavailable);
  expect(target.onEvent).not.toHaveBeenCalled();
  expect(basketSearchSummary(unavailable)).not.toEqual(basketSearchSummary({ status: "empty", sources: [], omittedCount: 0 }));
  expect(basketSearchSummary(unavailable)).not.toContain("PRIVATE_REASON");
});

test("optional discovery transport failures do not change retrieval", () => {
  const target = { onEvent: vi.fn(() => { throw new Error("display transport closed"); }) };
  expect(() => emitBasketDiscovery(target, { status: "found", omittedCount: 0, sources: [{
    sourceId: "one", expectedRevision: 1, displayName: "One", path: "/one", score: 0.9, matches: [],
  }] })).not.toThrow();
});
