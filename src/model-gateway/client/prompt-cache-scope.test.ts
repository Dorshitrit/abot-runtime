import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createModelGatewayClient } from "../client.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../../runtime/observability/debug-logger.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { vi.unstubAllGlobals(); resetDebugLoggerConfig(); });

test("forwards the conversation scope through count, chat and raw without using request identity", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (String(url).endsWith("/input-tokens")) return new Response(JSON.stringify({
      inputTokens: 1200, profileId: "main", provider: "openai", model: "supported-model",
      contextWindowTokens: 32000, source: "provider_input_token_count",
    }));
    if (String(url).endsWith("/raw")) return new Response(JSON.stringify({ text: "ok" }));
    return new Response(`${JSON.stringify({ type: "content", text: "ok" })}\n${JSON.stringify({ type: "done" })}\n`);
  }));
  const client = createModelGatewayClient({ inputTokenCountProviders: ["openai"] });
  const common = {
    agentMode: "reasoning" as const, modelStep: "execution.response" as const,
    promptCacheScope: "conversation", debugRequestId: "first", abortSignal: new AbortController().signal,
  };
  const messages = [{ role: "user", content: "Hello" }];
  await client.countInputTokens({ ...common, messages, provider: "openai" });
  await client.invoke({ ...common, messages });
  await client.invokeRaw({ ...common, debugRequestId: "second", prompt: "Hello again" });
  expect(bodies).toHaveLength(3);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies.map((body) => body.promptCacheScope)).toEqual(["conversation", "conversation", "conversation"]);
  expect(bodies.map((body) => body.debugRequestId)).toEqual(["first", "first", "second"]);
  expect(messages).toEqual([{ role: "user", content: "Hello" }]);
});
