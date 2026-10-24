import { afterEach, describe, expect, test, vi } from "vitest";
import { createModelGatewayClient } from "../client.js";

function parameters(provider: string) {
  return {
    provider, messages: [{ role: "user" as const, content: "Count this input." }],
    agentMode: "reasoning" as const, modelStep: "supervisor.response" as const,
    abortSignal: new AbortController().signal,
  };
}
function result(provider: string, inputTokens: number) {
  return Response.json({ inputTokens, provider, profileId: "test", model: "test-model",
    contextWindowTokens: 32768, source: "provider_input_token_count" });
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("input token count cache eligibility", () => {
  test("recounts identical llama.cpp input immediately and beyond the gateway measurement lifetime", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(result("llamacpp", 19))
      .mockResolvedValueOnce(result("llamacpp", 23))
      .mockResolvedValueOnce(result("llamacpp", 29));
    vi.stubGlobal("fetch", fetchMock);
    const client = createModelGatewayClient({ baseUrl: "http://gateway.test" });
    const params = parameters("llamacpp");
    expect((await client.countInputTokens(params))?.inputTokens).toBe(19);
    expect((await client.countInputTokens(params))?.inputTokens).toBe(23);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect((await client.countInputTokens(params))?.inputTokens).toBe(29);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => url === "http://gateway.test/input-tokens")).toBe(true);
  });

  test("preserves OpenAI caching across the same elapsed time", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(result("openai", 31));
    vi.stubGlobal("fetch", fetchMock);
    const client = createModelGatewayClient({ baseUrl: "http://gateway.test" });
    const params = parameters("openai");
    const first = await client.countInputTokens(params);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(await client.countInputTokens(params)).toBe(first);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("keeps Ollama unsupported and honors an explicit provider allowlist", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const defaults = createModelGatewayClient({ baseUrl: "http://gateway.test" });
    const disabled = createModelGatewayClient({ baseUrl: "http://gateway.test", inputTokenCountProviders: ["openai"] });
    expect(await defaults.countInputTokens(parameters("ollama"))).toBeUndefined();
    expect(await disabled.countInputTokens(parameters("llamacpp"))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
