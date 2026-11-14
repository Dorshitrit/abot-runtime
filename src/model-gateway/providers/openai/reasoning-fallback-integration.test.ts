import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import { createChatHandler, createInputTokenCountHandler, type GatewayResponse } from "../../server.js";
import { createInputTokenMeasurementStore } from "../../server/input-token-measurements.js";
import type { ModelGatewayEvent, ModelGatewayRequest } from "../../types.js";
import { createProviderEnvelopeFingerprint } from "../envelope-budget.js";
import { createChatGptProviderAdapter } from "../openai-chatgpt/adapter.js";
import { request as chatGptRequest } from "../openai-chatgpt/__tests__/fixture.js";
import { createOpenAIProviderAdapter } from "./adapter.js";
import { frame } from "./__tests__/native-function-fixture.js";
import { countOpenAIInputTokens } from "./input-token-count.js";

const endpointRoot = "https://reasoning-fallback.test/v1";
const policy = {
  providers: {
    test: { type: "openai", baseUrl: endpointRoot, apiKeyEnv: "REASONING_FALLBACK_TEST_KEY" },
  },
  profiles: {
    fixture: {
      provider: "test", model: "fixture-reasoning-model", contextWindowTokens: 128_000,
      supportsThinking: true, generation: { temperature: 0.2, topP: 0.9 },
    },
  },
  defaults: { profileId: "fixture" },
} as const;

function request(): ModelGatewayRequest {
  return {
    agentMode: "fast", modelStep: "supervisor.response", modelPolicy: policy,
    messages: [{ role: "system", content: "Keep this policy." }, { role: "user", content: "Reply briefly." }],
  };
}

function unsupportedEffort(status = 400): Response {
  return Response.json({ error: {
    type: "invalid_request_error", code: "unsupported_value", param: "reasoning.effort",
    message: "The requested reasoning effort is unsupported.",
  } }, { status });
}

function completedResponse(): Response {
  return new Response(
    frame({ type: "response.output_text.delta", delta: "Answer." })
      + frame({ type: "response.completed", response: {
        status: "completed", usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
      } }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function gatewayResponse(): GatewayResponse & { body: string } {
  return {
    body: "", setHeader: vi.fn(),
    write(chunk) { this.body += chunk; },
    end(chunk = "") { this.body += chunk; },
  };
}

function body(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function expectProviderDefaultRetry(original: Record<string, unknown>, retried: Record<string, unknown>) {
  expect(original.reasoning).toEqual({ effort: "none" });
  const { reasoning, temperature, top_p, ...unchanged } = original;
  expect({ reasoning, temperature, top_p }).toMatchObject({ reasoning: { effort: "none" } });
  expect(retried).toEqual(unchanged);
}

beforeEach(() => vi.stubEnv("REASONING_FALLBACK_TEST_KEY", "fixture-only"));
afterEach(() => vi.unstubAllEnvs());

describe("OpenAI reasoning fallback adapter integration", () => {
  test("count and chat share the measured provider-default envelope without extra generation", async () => {
    const requestBody = request();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(unsupportedEffort())
      .mockResolvedValueOnce(Response.json({ input_tokens: 11 }))
      .mockResolvedValueOnce(unsupportedEffort())
      .mockResolvedValueOnce(completedResponse());
    const options = { modelPolicy: policy, fetchImpl };
    const measurements = createInputTokenMeasurementStore();
    const counted = gatewayResponse();
    await createInputTokenCountHandler(options, measurements)(requestBody, counted);
    expect(JSON.parse(counted.body)).toMatchObject({ inputTokens: 11, source: "provider_input_token_count" });

    const countOriginal = body(fetchImpl.mock.calls[0]?.[1]);
    const countRetry = body(fetchImpl.mock.calls[1]?.[1]);
    expectProviderDefaultRetry(countOriginal, countRetry);
    const measurement = measurements.resolve({ requestBody, invocation: resolveModelInvocation(requestBody) });
    expect(measurement).toEqual({
      inputTokens: 11, source: "provider_input_token_count",
      providerEnvelopeFingerprint: createProviderEnvelopeFingerprint(countRetry),
    });

    const output = gatewayResponse();
    await createChatHandler(options, measurements)(requestBody, output);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `${endpointRoot}/responses/input_tokens`, `${endpointRoot}/responses/input_tokens`,
      `${endpointRoot}/responses`, `${endpointRoot}/responses`,
    ]);
    const chatOriginal = body(fetchImpl.mock.calls[2]?.[1]);
    const chatRetry = body(fetchImpl.mock.calls[3]?.[1]);
    expect(chatOriginal).toMatchObject({ temperature: 0.2, top_p: 0.9 });
    expectProviderDefaultRetry(chatOriginal, chatRetry);
    const { stream, ...chatInput } = chatRetry;
    expect(stream).toBe(true);
    expect(chatInput).toEqual(countRetry);
    expect(createProviderEnvelopeFingerprint(chatRetry)).toBe(measurement?.providerEnvelopeFingerprint);
    const events = output.body.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ModelGatewayEvent);
    expect(events.filter((event) => event.type === "content")).toEqual([{ type: "content", text: "Answer." }]);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test("raw requests recover once with the same content and provider-default reasoning", async () => {
    const requestBody = request();
    const originalRequest = structuredClone(requestBody);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(unsupportedEffort())
      .mockResolvedValueOnce(completedResponse());
    const result = await createOpenAIProviderAdapter().invoke({
      endpoint: "raw", requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl,
    });
    expect(result).toMatchObject({ kind: "raw", body: { text: "Answer." } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expectProviderDefaultRetry(body(fetchImpl.mock.calls[0]?.[1]), body(fetchImpl.mock.calls[1]?.[1]));
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toEqual(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(requestBody).toEqual(originalRequest);
  });

  describe.each(["count", "chat", "raw"] as const)("%s failure boundaries", (endpoint) => {
    test.each([401, 500])("does not retry an HTTP %s even if its body mentions reasoning.effort", async (status) => {
      const requestBody = request();
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(unsupportedEffort(status));
      const params = { endpoint: endpoint === "raw" ? "raw" as const : "chat" as const,
        requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl };
      const result = endpoint === "count"
        ? await countOpenAIInputTokens(params)
        : await createOpenAIProviderAdapter().invoke(params);
      expect(result).toMatchObject({ kind: "error", statusCode: status });
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    test("does not retry again after the provider-default attempt is rejected", async () => {
      const requestBody = request();
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(unsupportedEffort())
        .mockResolvedValueOnce(unsupportedEffort());
      const params = { endpoint: endpoint === "raw" ? "raw" as const : "chat" as const,
        requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl };
      const result = endpoint === "count"
        ? await countOpenAIInputTokens(params)
        : await createOpenAIProviderAdapter().invoke(params);
      expect(result).toMatchObject({ kind: "error", statusCode: 400 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  test.each(["chat", "raw"] as const)("does not regenerate after a %s stream failure", async (endpoint) => {
    const requestBody = request();
    const failure = { type: "response.failed", response: { error: {
      type: "invalid_request_error", code: "unsupported_value", param: "reasoning.effort",
      message: "The stream failed after generation started.",
    } } };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(frame(failure), {
      headers: { "Content-Type": "text/event-stream" },
    }));
    const events: ModelGatewayEvent[] = [];
    const operation = async () => {
      const result = await createOpenAIProviderAdapter().invoke({
        endpoint, requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl,
      });
      if (result.kind === "chat") await result.stream({ emit: (event) => events.push(event) });
      return result;
    };
    const result = operation();
    if (endpoint === "raw") await expect(result).rejects.toThrow();
    if (endpoint === "chat") {
      await expect(result).resolves.toMatchObject({ kind: "chat" });
      expect(events).toEqual([{ type: "error", error: failure.response.error.message }]);
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test("does not add OpenAI API fallback to the separate ChatGPT adapter", async () => {
    const requestBody: ModelGatewayRequest = { ...chatGptRequest, agentMode: "fast" };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(unsupportedEffort());
    const result = await createChatGptProviderAdapter({ getAccessToken: async () => "fixture-only" }).invoke({
      endpoint: "raw", requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl,
    });
    expect(result).toMatchObject({ kind: "error", statusCode: 400 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(body(fetchImpl.mock.calls[0]?.[1])).toHaveProperty("reasoning.effort", "none");
  });
});
