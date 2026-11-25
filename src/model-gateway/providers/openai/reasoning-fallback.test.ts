import { expect, test, vi } from "vitest";
import type { ModelGatewayRequest, ResolvedModelInvocation } from "../../types.js";
import { fetchWithOpenAIReasoningFallback } from "./reasoning-fallback.js";

vi.mock("../../../runtime/observability/debug-logger.js", () => ({ traceDebug: vi.fn() }));

const requestBody: ModelGatewayRequest = { agentMode: "fast", modelStep: "execution.decision" };
const rejection = {
  type: "invalid_request_error",
  param: "reasoning.effort",
  code: "unsupported_value",
  message: "This setting is not supported.",
};

function invocation(model: string, provider = "openai"): ResolvedModelInvocation {
  return {
    model,
    profile: {
      id: "test-profile", label: "Test", providerId: provider, provider, model,
      contextWindowTokens: 32_768, supportsThinking: true,
      capabilities: { inputModalities: ["text"], outputModalities: ["text"] },
      options: {}, generation: {}, context: {},
    },
  };
}

function payloadFor(model = "arbitrary-model", effort = "none") {
  return {
    model,
    reasoning: { effort, summary: "auto" },
    input: [{ role: "user", content: "Explain this result." }],
    text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
    tools: [{ type: "function", name: "inspect", parameters: { type: "object" } }],
    temperature: 0.2,
    top_p: 0.9,
  };
}

function rejectedResponse(error: Record<string, unknown> = rejection, status = 400): Response {
  return new Response(JSON.stringify({ error }), { status });
}

test.each(["none", "low", "high"])("preserves a supported %s effort and exact payload", async (effort) => {
  const payload = payloadFor("unrecognized-future-model", effort);
  const original = structuredClone(payload);
  const response = new Response("accepted");
  const result = { response, responseTrace: Promise.resolve(), marker: "original" };
  const send = vi.fn(async (_payload: Record<string, unknown>) => result);

  const output = await fetchWithOpenAIReasoningFallback({
    payload, requestBody, invocation: invocation(payload.model), send,
  });

  expect(send).toHaveBeenCalledExactlyOnceWith(payload);
  expect(send.mock.calls[0]![0]).toBe(payload);
  expect(output.result).toBe(result);
  expect(output.payload).toBe(payload);
  expect(payload).toEqual(original);
  expect(response.bodyUsed).toBe(false);
  expect(await response.text()).toBe("accepted");
});

test.each([
  ["arbitrary-alpha", "none", "unsupported_value"],
  ["unrelated-beta", "high", "unsupported_value"],
  ["arbitrary-gamma", "none", "unsupported_parameter"],
  ["future-delta", "high", "unsupported_parameter"],
])("uses provider default for %s rejecting %s (%s)", async (model, effort, code) => {
  const payload = payloadFor(model, effort);
  const original = structuredClone(payload);
  const accepted = { response: new Response("accepted") };
  const send = vi.fn<(body: Record<string, unknown>) => Promise<{ response: Response }>>()
    .mockResolvedValueOnce({ response: rejectedResponse({ ...rejection, code }) })
    .mockResolvedValueOnce(accepted);

  const output = await fetchWithOpenAIReasoningFallback({
    payload, requestBody, invocation: invocation(model), send,
  });

  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]![0]).toBe(payload);
  expect(send.mock.calls[1]![0]).toEqual({
    model, reasoning: { summary: "auto" }, input: original.input,
    text: original.text, tools: original.tools,
  });
  expect(output.payload).toBe(send.mock.calls[1]![0]);
  expect(output.result).toBe(accepted);
  expect(payload).toEqual(original);
});

test("omits the whole reasoning object when effort was its only field", async () => {
  const payload = { model: "any-model", reasoning: { effort: "none" }, input: [] };
  const send = vi.fn<(body: Record<string, unknown>) => Promise<{ response: Response }>>()
    .mockResolvedValueOnce({ response: rejectedResponse() })
    .mockResolvedValueOnce({ response: new Response("accepted") });

  const output = await fetchWithOpenAIReasoningFallback({
    payload, requestBody, invocation: invocation(payload.model), send,
  });

  expect(send).toHaveBeenCalledTimes(2);
  expect(output.payload).toEqual({ model: payload.model, input: [] });
  expect(payload.reasoning).toEqual({ effort: "none" });
});

test("stops after two sends even when the second response repeats the rejection", async () => {
  const payload = payloadFor();
  const second = { response: rejectedResponse() };
  const send = vi.fn<(body: Record<string, unknown>) => Promise<{ response: Response }>>()
    .mockResolvedValueOnce({ response: rejectedResponse() })
    .mockResolvedValue(second);

  const output = await fetchWithOpenAIReasoningFallback({
    payload, requestBody, invocation: invocation(payload.model), send,
  });

  expect(send).toHaveBeenCalledTimes(2);
  expect(output.result).toBe(second);
  expect(second.response.status).toBe(400);
  expect(second.response.bodyUsed).toBe(false);
  expect(await second.response.json()).toEqual({ error: rejection });
});

test.each([
  JSON.stringify({ error: { ...rejection, param: "temperature" } }),
  JSON.stringify({ error: { ...rejection, type: "authentication_error" } }),
  JSON.stringify({ error: { ...rejection, code: "invalid_value" } }),
  JSON.stringify({ error: { message: JSON.stringify(rejection) } }),
  JSON.stringify({ error: [rejection] }),
  JSON.stringify(rejection),
  "{invalid json",
])("preserves unrelated or malformed HTTP errors without retry: %s", async (body) => {
  const payload = payloadFor();
  const response = new Response(body, { status: 400, headers: { "x-request-id": "test-request" } });
  const result = { response };
  const send = vi.fn(async (_body: Record<string, unknown>) => result);

  const output = await fetchWithOpenAIReasoningFallback({
    payload, requestBody, invocation: invocation(payload.model), send,
  });

  expect(send).toHaveBeenCalledOnce();
  expect(output.result).toBe(result);
  expect(output.payload).toBe(payload);
  expect(response.status).toBe(400);
  expect(response.headers.get("x-request-id")).toBe("test-request");
  expect(response.bodyUsed).toBe(false);
  expect(await response.text()).toBe(body);
});

test.each([200, 401, 429, 500])("does not retry HTTP %s despite matching error text", async (status) => {
  const payload = payloadFor();
  const response = rejectedResponse(rejection, status);
  const send = vi.fn(async (_body: Record<string, unknown>) => ({ response }));

  const output = await fetchWithOpenAIReasoningFallback({
    payload, requestBody, invocation: invocation(payload.model), send,
  });

  expect(send).toHaveBeenCalledOnce();
  expect(output.result.response).toBe(response);
  expect(await response.json()).toEqual({ error: rejection });
});

test.each([undefined, {}, { summary: "auto" }, { effort: null }])(
  "does not retry when no explicit effort was sent: %j", async (reasoning) => {
    const payload = { model: "any-model", reasoning };
    const response = rejectedResponse();
    const send = vi.fn(async (_body: Record<string, unknown>) => ({ response }));

    const output = await fetchWithOpenAIReasoningFallback({
      payload, requestBody, invocation: invocation(payload.model), send,
    });

    expect(send).toHaveBeenCalledOnce();
    expect(output.payload).toBe(payload);
    expect(await response.json()).toEqual({ error: rejection });
  },
);

test("never applies the OpenAI fallback to ChatGPT", async () => {
  const payload = payloadFor("same-model-as-api");
  const response = rejectedResponse();
  const send = vi.fn(async (_body: Record<string, unknown>) => ({ response }));

  const output = await fetchWithOpenAIReasoningFallback({
    payload, requestBody, invocation: invocation(payload.model, "openai-chatgpt"), send,
  });

  expect(send).toHaveBeenCalledExactlyOnceWith(payload);
  expect(output.payload).toBe(payload);
  expect(await response.json()).toEqual({ error: rejection });
});

test("honors an abort before retry without sending a second request", async () => {
  const payload = payloadFor();
  const abort = new AbortController();
  const reason = new Error("request cancelled");
  const onIssue = vi.fn();
  const send = vi.fn(async (_body: Record<string, unknown>) => ({
    response: rejectedResponse(),
    responseTrace: Promise.resolve().then(() => abort.abort(reason)),
  }));

  await expect(fetchWithOpenAIReasoningFallback({
    payload, requestBody, invocation: invocation(payload.model), send, abortSignal: abort.signal, onIssue,
  })).rejects.toBe(reason);

  expect(send).toHaveBeenCalledOnce();
  expect(onIssue).toHaveBeenCalledTimes(2);
  expect(onIssue.mock.calls[0]![0]).toMatchObject({ outcome: "pending" });
  expect(onIssue.mock.calls[1]![0]).toEqual({ ...onIssue.mock.calls[0]![0], outcome: "interrupted" });
});

test("does not replay an ambiguous transport failure", async () => {
  const payload = payloadFor();
  const failure = new Error("connection reset after upload");
  const send = vi.fn<(body: Record<string, unknown>) => Promise<{ response: Response }>>()
    .mockRejectedValue(failure);

  await expect(fetchWithOpenAIReasoningFallback({
    payload, requestBody, invocation: invocation(payload.model), send,
  })).rejects.toBe(failure);

  expect(send).toHaveBeenCalledOnce();
});
