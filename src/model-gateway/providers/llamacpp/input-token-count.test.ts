import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../../../runtime/observability/debug-logger.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayRequest } from "../../types.js";
import { createProviderEnvelopeFingerprint } from "../envelope-budget.js";
import { countLlamaCppInputTokens } from "./input-token-count.js";
import { buildLlamaCppChatPayload } from "./payload.js";

function request(baseUrl = "http://llamacpp.test"): ModelGatewayRequest {
  return {
    agentMode: "deep",
    modelStep: "supervisor.response",
    modelPolicy: {
      providers: { local: { type: "llamacpp", baseUrl } },
      profiles: { gemma: {
        provider: "local", model: "counted-gemma", contextWindowTokens: 32768,
        supportsThinking: true,
        generation: { temperature: 0.6, topP: 0.9, reasoningBudget: { mode: "tokens", tokens: 321 } },
        calibration: { response: { instructions: ["Stage calibration."] } },
      } },
      defaults: { profileId: "gemma", steps: { "supervisor.response": "response" } },
    },
    messages: [
      { role: "system", content: "Caller instruction." },
      { role: "user", content: "שלום 🧪" },
      { role: "assistant", content: "", toolCalls: [{ callId: "a", name: "read", arguments: '{ "path": "é" }' }] },
      { role: "tool", content: '{"result":"שלום"}\n', toolCallId: "a", toolName: "read" },
    ],
    format: { type: "json_schema", name: "result", strict: true,
      schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } },
  };
}

function count(fetchImpl: typeof fetch, requestBody = request()) {
  return countLlamaCppInputTokens({ endpoint: "chat", requestBody,
    invocation: resolveModelInvocation(requestBody), fetchImpl });
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { vi.unstubAllEnvs(); resetDebugLoggerConfig(); });

describe("llama.cpp native input token counting", () => {
  test.each(["http://llamacpp.test", "http://llamacpp.test/v1/"])("counts the complete generation envelope at %s", async (baseUrl) => {
    const requestBody = request(baseUrl);
    requestBody.modelPolicy!.providers!.local!.apiKeyEnv = "LLAMACPP_COUNT_TEST_KEY";
    vi.stubEnv("LLAMACPP_COUNT_TEST_KEY", "test-credential");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ input_tokens: 37, object: "response.input_tokens" }));
    const result = await count(fetchImpl, requestBody);
    const expected = buildLlamaCppChatPayload({ endpoint: "chat", requestBody, invocation: resolveModelInvocation(requestBody) });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://llamacpp.test/v1/chat/completions/input_tokens");
    expect(init?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer test-credential" });
    expect(JSON.parse(String(init?.body))).toEqual(expected);
    expect(expected).toMatchObject({ reasoning_effort: "high", reasoning_budget_tokens: 321,
      chat_template_kwargs: { enable_thinking: true }, response_format: { type: "json_schema" } });
    expect(expected.messages).toEqual([
      { role: "system", content: "Stage calibration." },
      { role: "system", content: "Caller instruction." },
      { role: "user", content: "שלום 🧪" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: '{ "path": "é" }' } }] },
      { role: "tool", content: '{"result":"שלום"}\n', tool_call_id: "a", name: "read" },
    ]);
    expect(result).toEqual({ kind: "counted", inputTokens: 37,
      providerEnvelopeFingerprint: createProviderEnvelopeFingerprint(expected) });
  });

  test("counts raw requests with the same raw-to-chat projection", async () => {
    const requestBody = request();
    requestBody.messages = undefined;
    requestBody.prompt = "Exact raw bytes\nשלום";
    const invocation = resolveModelInvocation(requestBody);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ input_tokens: 12 }));
    await countLlamaCppInputTokens({ endpoint: "raw", requestBody, invocation, fetchImpl });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual(
      buildLlamaCppChatPayload({ endpoint: "raw", requestBody, invocation }),
    );
  });

  test.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts provider count %s", async (input_tokens) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ input_tokens }));
    expect(await count(fetchImpl)).toMatchObject({ kind: "counted", inputTokens: input_tokens });
  });

  test.each([{}, [], null, { input_tokens: -1 }, { input_tokens: 1.5 },
    { input_tokens: "12" }, { input_tokens: Number.MAX_SAFE_INTEGER + 1 }])("rejects malformed count %j", async (body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    expect(await count(fetchImpl)).toEqual({ kind: "error", statusCode: 502,
      message: "llamacpp input token count response invalid" });
  });

  test("rejects malformed JSON without claiming an estimated count", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("invalid JSON"));
    expect(await count(fetchImpl)).toMatchObject({ kind: "error", statusCode: 502 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test.each([401, 404, 503])("preserves HTTP %s without another endpoint or inference", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("native count unavailable", { status }));
    expect(await count(fetchImpl)).toEqual({ kind: "error", statusCode: status, message: "native count unavailable" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test("rejects invalid configuration before provider access", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await count(fetchImpl, request(""))).toMatchObject({ kind: "error", statusCode: 500,
      message: "llamacpp_base_url_required" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("propagates transport failure and aborted response-body reads", async () => {
    const aborted = new DOMException("count aborted", "AbortError");
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(aborted);
    await expect(count(fetchImpl)).rejects.toThrow("count aborted");
    const abortedBody = Response.json({});
    vi.spyOn(abortedBody, "json").mockRejectedValue(aborted);
    fetchImpl.mockResolvedValue(abortedBody);
    await expect(count(fetchImpl)).rejects.toBe(aborted);
  });
});
