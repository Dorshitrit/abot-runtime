import { describe, expect, test } from "vitest";
import { OpenAIResponsesStreamNormalizer } from "./stream-normalizer.js";

function completedUsage(inputDetails: Record<string, unknown>) {
  const normalizer = new OpenAIResponsesStreamNormalizer({ requireCompletedResponse: true });
  return normalizer.consume({
    type: "response.completed",
    response: {
      status: "completed",
      output: [],
      usage: {
        input_tokens: 12_000,
        input_tokens_details: inputDetails,
        output_tokens: 30,
        output_tokens_details: { reasoning_tokens: 10 },
        total_tokens: 12_030,
      },
    },
  });
}

describe("OpenAI cache-write usage projection", () => {
  test("preserves wire write counts and disjoint lifetimes in the gateway completion", () => {
    expect(completedUsage({
      cached_tokens: 4_000,
      cache_write_tokens: 7_000,
      cache_write_tokens_details: { ttl_30m_tokens: 3_000, ttl_12h_tokens: 4_000 },
    })).toEqual([{
      type: "done", done: true,
      usage: {
        inputTokens: 12_000,
        cachedInputTokens: 4_000,
        cacheWriteInputTokens: 7_000,
        cacheWriteInputTokensDetails: { ttl30mTokens: 3_000, ttl12hTokens: 4_000 },
        outputTokens: 30,
        reasoningTokens: 10,
        totalTokens: 12_030,
      },
    }]);
  });

  test("does not fabricate zero write data for older Responses usage", () => {
    expect(completedUsage({ cached_tokens: 4_000 })).toEqual([{
      type: "done", done: true,
      usage: {
        inputTokens: 12_000,
        cachedInputTokens: 4_000,
        outputTokens: 30,
        reasoningTokens: 10,
        totalTokens: 12_030,
      },
    }]);
  });

  test("keeps aggregate writes when provider lifetime detail is malformed", () => {
    expect(completedUsage({
      cached_tokens: 4_000,
      cache_write_tokens: 7_000,
      cache_write_tokens_details: { ttl_30m_tokens: 7_000 },
    })).toEqual([{
      type: "done", done: true,
      usage: {
        inputTokens: 12_000,
        cachedInputTokens: 4_000,
        cacheWriteInputTokens: 7_000,
        outputTokens: 30,
        reasoningTokens: 10,
        totalTokens: 12_030,
      },
    }]);
  });
});
