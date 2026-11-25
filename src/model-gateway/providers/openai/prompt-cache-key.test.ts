import { describe, expect, test } from "vitest";
import type { ModelGatewayRequest } from "../../types.js";
import { createProviderEnvelopeFingerprint } from "../envelope-budget.js";
import { buildChatGptResponsesPayload } from "../openai-chatgpt/payload.js";
import { buildOllamaPayload } from "../ollama/payload.js";
import { buildOpenAIInputTokenCountPayload, buildOpenAIResponsesPayload } from "./payload.js";
import { resolveOpenAIPromptCacheKey } from "./prompt-cache-key.js";

function request(overrides: Partial<ModelGatewayRequest> = {}): ModelGatewayRequest {
  return {
    messages: [{ role: "system", content: "Fixed instructions" }, { role: "user", content: "First turn" }],
    agentMode: "reasoning", modelStep: "execution.response", debugRequestId: "request-1",
    promptCacheScope: "conversation-private-id",
    modelPolicy: {
      providers: { remote: { type: "openai" } },
      profiles: { main: { provider: "remote", model: "supported-model", contextWindowTokens: 32000 } },
      defaults: { profileId: "main" },
    },
    ...overrides,
  };
}

describe("OpenAI conversation cache identity", () => {
  test("keeps one opaque key across conversation turns, steps and reconstructed requests", () => {
    const first = request();
    const second = JSON.parse(JSON.stringify(first)) as ModelGatewayRequest;
    second.debugRequestId = "request-2";
    second.modelStep = "supervisor.response";
    second.messages = [...first.messages as unknown[], { role: "user", content: "Follow up" }];
    const key = buildOpenAIResponsesPayload(first).prompt_cache_key;
    expect(typeof key).toBe("string");
    expect(String(key).length).toBeLessThanOrEqual(64);
    expect(key).not.toContain(first.promptCacheScope);
    expect(buildOpenAIResponsesPayload(second).prompt_cache_key).toBe(key);
    expect(buildOpenAIResponsesPayload(request({ promptCacheScope: "different-conversation" })).prompt_cache_key).not.toBe(key);
  });

  test("changes only provider cache metadata, never the prompt or schema", () => {
    const input = request({ modelStep: "execution.decision", format: {
      type: "json_schema", name: "decision", strict: true,
      schema: { type: "object", properties: { decision: { type: "string" } }, required: ["decision"], additionalProperties: false },
    } });
    const { prompt_cache_key: _key, ...scoped } = buildOpenAIResponsesPayload(input);
    expect(scoped).toEqual(buildOpenAIResponsesPayload({ ...input, promptCacheScope: undefined }));
  });

  test.each([undefined, null, "", "   ", 42, {}])("omits invalid conversation scope %j", (scope) => {
    expect(resolveOpenAIPromptCacheKey(scope)).toBeUndefined();
    expect(buildOpenAIResponsesPayload(request({ promptCacheScope: scope as string }))).not.toHaveProperty("prompt_cache_key");
  });

  test("omits cache partition metadata from token counting without changing its binding", () => {
    const generated = buildOpenAIResponsesPayload(request());
    const counted = buildOpenAIInputTokenCountPayload(request());
    expect(counted).not.toHaveProperty("prompt_cache_key");
    expect(createProviderEnvelopeFingerprint(counted)).toBe(createProviderEnvelopeFingerprint(generated));
    expect(counted).toEqual(buildOpenAIInputTokenCountPayload(request({ promptCacheScope: "another" })));
  });

  test.each(["openai-chatgpt", "ollama"])("does not change %s provider payloads", (provider) => {
    const input = request();
    input.modelPolicy!.providers!.remote!.type = provider;
    const build = provider === "openai-chatgpt" ? buildChatGptResponsesPayload : buildOllamaPayload;
    expect(build(input)).toEqual(build({ ...input, promptCacheScope: undefined }));
  });
});
