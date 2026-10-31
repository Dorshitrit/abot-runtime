import { afterEach, expect, test, vi } from "vitest";
import { createModelGatewayClient } from "../client.js";
import type { ModelGatewayPolicyConfig } from "../types.js";

const policy: ModelGatewayPolicyConfig = {
  providers: { remote: { type: "openai" } },
  profiles: { supported: { provider: "remote", model: "supported-model", contextWindowTokens: 32000, options: { prompt_cache_options: { mode: "implicit" } } } },
  defaults: { profileId: "supported" },
};
const params = {
  messages: [
    { role: "system" as const, content: "Stable instructions" },
    { role: "user" as const, content: "Current request" },
    { role: "user" as const, content: "Volatile activation" },
  ],
  agentMode: "reasoning" as const,
  modelStep: "execution.decision" as const,
  abortSignal: new AbortController().signal,
};
afterEach(() => vi.unstubAllGlobals());

function mockGateway() {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return String(url).endsWith("/input-tokens")
      ? new Response(JSON.stringify({ inputTokens: 1200, profileId: "supported", provider: "openai", model: "supported-model", contextWindowTokens: 32000, source: "provider_input_token_count" }))
      : new Response(`${JSON.stringify({ type: "content", text: "done" })}\n${JSON.stringify({ type: "done" })}\n`);
  }));
  return { bodies, client: createModelGatewayClient({ modelPolicy: policy, inputTokenCountProviders: ["openai"] }) };
}

test("forwards the same out-of-band index for token counting and generation", async () => {
  const { bodies, client } = mockGateway();
  const input = { ...params, promptCacheBoundaryBeforeMessageIndex: 2 };
  await client.countInputTokens({ ...input, provider: "openai" });
  await client.invoke(input);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toMatchObject({ promptCacheBoundaryBeforeMessageIndex: 2, messages: params.messages });
  expect(params.messages.every((message) => Object.keys(message).length === 2)).toBe(true);
});

test("keeps legacy requests free of the hint and distinguishes measured boundary envelopes", async () => {
  const { bodies, client } = mockGateway();
  await client.countInputTokens({ ...params, provider: "openai" });
  await client.countInputTokens({ ...params, provider: "openai", promptCacheBoundaryBeforeMessageIndex: 1 });
  await client.countInputTokens({ ...params, provider: "openai", promptCacheBoundaryBeforeMessageIndex: 2 });
  await client.countInputTokens({ ...params, provider: "openai", promptCacheBoundaryBeforeMessageIndex: 2 });
  expect(bodies).toHaveLength(3);
  expect(bodies[0]).not.toHaveProperty("promptCacheBoundaryBeforeMessageIndex");
  expect(bodies[1]).toHaveProperty("promptCacheBoundaryBeforeMessageIndex", 1);
  expect(bodies[2]).toHaveProperty("promptCacheBoundaryBeforeMessageIndex", 2);
});
