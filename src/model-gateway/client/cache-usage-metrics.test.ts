import { afterEach, describe, expect, test, vi } from "vitest";
import { invokeModelGateway, invokeRawModelGateway } from "../client.js";
import { normalizeModelTokenUsage } from "../protocol/usage.js";
import { traceDebug } from "../../runtime/observability/debug-logger.js";
import { buildModelInvocationMetrics } from "./invocation-metrics.js";

vi.mock("../../runtime/observability/debug-logger.js", () => ({ traceDebug: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

const usage = {
  inputTokens: 12_000,
  cachedInputTokens: 4_000,
  cacheWriteInputTokens: 7_000,
  cacheWriteInputTokensDetails: { ttl30mTokens: 3_000, ttl12hTokens: 4_000 },
  outputTokens: 30,
  totalTokens: 12_030,
};

function metricsFor(providerUsage: unknown) {
  return buildModelInvocationMetrics({
    providerUsage: normalizeModelTokenUsage(providerUsage),
    durationMs: 1,
    status: "success",
  });
}

describe("cache accounting in invocation metrics", () => {
  test("distinguishes ordinary input from legacy uncached input without estimating prices", () => {
    expect(metricsFor(usage)).toMatchObject({
      ...usage,
      ordinaryInputTokens: 1_000,
      uncachedInputTokens: 8_000,
      tokenUsageSource: "provider",
    });
  });

  test("does not assume missing cache writes are zero for legacy providers", () => {
    const { cacheWriteInputTokens: _writes, cacheWriteInputTokensDetails: _details, ...legacy } = usage;
    const metrics = metricsFor(legacy);
    expect(metrics).toMatchObject({ uncachedInputTokens: 8_000, cachedInputTokens: 4_000 });
    expect(metrics).not.toHaveProperty("cacheWriteInputTokens");
    expect(metrics).not.toHaveProperty("cacheWriteInputTokensDetails");
    expect(metrics).not.toHaveProperty("ordinaryInputTokens");
  });

  test("does not assume missing cache reads are zero", () => {
    const { cachedInputTokens: _reads, ...withoutReads } = usage;
    const metrics = metricsFor(withoutReads);
    expect(metrics).toMatchObject({ cacheWriteInputTokens: 7_000 });
    expect(metrics).not.toHaveProperty("uncachedInputTokens");
    expect(metrics).not.toHaveProperty("ordinaryInputTokens");
  });

  test("preserves explicit zero counts", () => {
    expect(metricsFor({
      ...usage,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      cacheWriteInputTokensDetails: { ttl30mTokens: 0, ttl12hTokens: 0 },
    })).toMatchObject({
      ordinaryInputTokens: 12_000,
      uncachedInputTokens: 12_000,
      cacheWriteInputTokens: 0,
      cacheWriteInputTokensDetails: { ttl30mTokens: 0, ttl12hTokens: 0 },
    });
  });

  test("never derives ordinary input from rejected overlapping counts", () => {
    const metrics = metricsFor({ ...usage, cacheWriteInputTokens: 8_001 });
    expect(metrics).toMatchObject({ uncachedInputTokens: 8_000 });
    expect(metrics).not.toHaveProperty("ordinaryInputTokens");
  });

  test("does not derive negative ordinary input from a directly supplied inconsistent usage object", () => {
    const metrics = buildModelInvocationMetrics({
      providerUsage: { ...usage, cacheWriteInputTokens: 9_000 },
      durationMs: 1,
      status: "success",
    });
    expect(metrics).not.toHaveProperty("ordinaryInputTokens");
  });

  test("preserves estimated metrics when there is no provider usage", () => {
    const metrics = metricsFor(undefined);
    expect(metrics).toMatchObject({ tokenUsageSource: "estimated" });
    for (const field of ["cachedInputTokens", "cacheWriteInputTokens", "ordinaryInputTokens"]) {
      expect(metrics).not.toHaveProperty(field);
    }
  });

  test("preserves accounting from the gateway done event through client metadata and metrics", async () => {
    vi.mocked(traceDebug).mockClear();
    const wire = [
      JSON.stringify({ type: "content", text: "done" }),
      JSON.stringify({ type: "done", usage }),
      "",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wire, { status: 200 })));

    const result = await invokeModelGateway({
      text: "continue",
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
    });

    expect(result.meta.usage).toEqual(usage);
    expect(traceDebug).toHaveBeenCalledWith(
      "runtime.model", "model.invocation.metrics",
      expect.objectContaining({ ...usage, ordinaryInputTokens: 1_000, uncachedInputTokens: 8_000 }),
    );
  });


  test("preserves accounting through the raw gateway response and invocation metrics", async () => {
    vi.mocked(traceDebug).mockClear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "done", usage }), { status: 200 }),
    ));

    const result = await invokeRawModelGateway({
      prompt: "continue",
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
    });

    expect(result.meta.usage).toEqual(usage);
    expect(traceDebug).toHaveBeenCalledWith(
      "runtime.model", "model.invocation.metrics",
      expect.objectContaining({ ...usage, ordinaryInputTokens: 1_000, uncachedInputTokens: 8_000 }),
    );
  });
});
