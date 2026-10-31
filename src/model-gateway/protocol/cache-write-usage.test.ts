import { describe, expect, test } from "vitest";
import { buildModelTokenUsage, normalizeModelTokenUsage } from "./usage.js";

const baseUsage = {
  inputTokens: 12_000,
  outputTokens: 30,
  totalTokens: 12_030,
  cachedInputTokens: 4_000,
  reasoningTokens: 10,
};

describe("optional cache-write usage accounting", () => {
  test("preserves disjoint cache-write lifetimes through repeated wire normalization", () => {
    const usage = {
      ...baseUsage,
      cacheWriteInputTokens: 7_000,
      cacheWriteInputTokensDetails: { ttl30mTokens: 3_000, ttl12hTokens: 4_000 },
    };
    expect(buildModelTokenUsage(usage)).toEqual(usage);
    expect(normalizeModelTokenUsage(JSON.parse(JSON.stringify(usage)))).toEqual(usage);
  });

  test("retains legacy provider usage exactly without adding zero write counts", () => {
    expect(buildModelTokenUsage(baseUsage)).toEqual(baseUsage);
    expect(normalizeModelTokenUsage(baseUsage)).toEqual(baseUsage);
    expect(buildModelTokenUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
    });
  });

  test("retains explicit zero aggregate and zero lifetimes", () => {
    const usage = {
      ...baseUsage,
      cacheWriteInputTokens: 0,
      cacheWriteInputTokensDetails: { ttl30mTokens: 0, ttl12hTokens: 0 },
    };
    expect(buildModelTokenUsage(usage)).toEqual(usage);
  });

  test("accepts write totals without inventing missing read or lifetime counts", () => {
    expect(buildModelTokenUsage({
      inputTokens: 10, outputTokens: 5, cacheWriteInputTokens: 10,
    })).toEqual({
      inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheWriteInputTokens: 10,
    });
  });

  test.each([undefined, null, "7000", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 8_001])(
    "omits invalid or overlapping write total %s without losing ordinary usage",
    (cacheWriteInputTokens) => {
      expect(buildModelTokenUsage({
        ...baseUsage,
        cacheWriteInputTokens,
        cacheWriteInputTokensDetails: { ttl30mTokens: 3_000, ttl12hTokens: 4_000 },
      })).toEqual(baseUsage);
    },
  );

  test("accepts writes filling all input left after cache reads", () => {
    expect(buildModelTokenUsage({ ...baseUsage, cacheWriteInputTokens: 8_000 }))
      .toEqual({ ...baseUsage, cacheWriteInputTokens: 8_000 });
  });

  test.each([
    undefined,
    null,
    [],
    "details",
    {},
    { ttl30mTokens: 7_000 },
    { ttl30mTokens: "3000", ttl12hTokens: 4_000 },
    { ttl30mTokens: -1, ttl12hTokens: 7_001 },
    { ttl30mTokens: 0.5, ttl12hTokens: 6_999.5 },
    { ttl30mTokens: Infinity, ttl12hTokens: 0 },
    { ttl30mTokens: Number.MAX_SAFE_INTEGER + 1, ttl12hTokens: 0 },
    { ttl30mTokens: 3_000, ttl12hTokens: 3_999 },
  ])("keeps valid aggregate when lifetime breakdown is unavailable or inconsistent: %j", (details) => {
    expect(buildModelTokenUsage({
      ...baseUsage,
      cacheWriteInputTokens: 7_000,
      cacheWriteInputTokensDetails: details,
    })).toEqual({ ...baseUsage, cacheWriteInputTokens: 7_000 });
  });
});
