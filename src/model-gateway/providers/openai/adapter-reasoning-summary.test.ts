import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayEvent, ModelGatewayRequest } from "../../types.js";
import { traceModelIo } from "../../observability/trace-store.js";
import { createOpenAIProviderAdapter } from "./adapter.js";
import { invokeOpenAIResponses } from "./responses-invocation.js";
import { completedFunction, functionArguments, nativeRequest, sse } from "./__tests__/native-function-fixture.js";

vi.mock("../../observability/trace-store.js", () => ({
  isModelIoTraceEnabled: () => true,
  traceModelIo: vi.fn(async () => {}),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

const summary = "Inspect the selected file before deciding.";
const events = [
  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0,
    summary_index: 0, sequence_number: 1, delta: summary },
  { type: "response.reasoning_summary_text.done", item_id: "rs_1", output_index: 0,
    summary_index: 0, sequence_number: 2, text: summary },
  completedFunction,
];

function request(enabled: boolean): ModelGatewayRequest {
  const value = structuredClone(nativeRequest);
  value.modelPolicy!.profiles!.test.options = enabled ? { reasoningSummary: "auto" } : {};
  return value;
}

describe.each([true, false])("OpenAI summary adapter enabled=%s", (enabled) => {
  test.each(["chat", "raw"] as const)("%s preserves function output and trace parity", async (endpoint) => {
    vi.stubEnv("NATIVE_TEST_KEY", "fixture-only");
    const requestBody = request(enabled);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(sse(events)));
    const result = await createOpenAIProviderAdapter().invoke({
      endpoint, requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl,
    });
    if (result.kind === "chat") {
      const forwarded: ModelGatewayEvent[] = [];
      await result.stream({ emit: (event) => forwarded.push(event) });
      expect(forwarded.filter((event) => event.type === "thinking"))
        .toEqual(enabled ? [{ type: "thinking", text: summary }] : []);
      expect(forwarded.filter((event) => event.type === "content"))
        .toEqual([{ type: "content", text: functionArguments }]);
      expect(forwarded.at(-1)).toMatchObject({ type: "done" });
    } else {
      expect(result).toMatchObject({ kind: "raw", body: { text: functionArguments, thinking: enabled ? summary : "" } });
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).reasoning)
      .toEqual(enabled ? { effort: "medium", summary: "auto" } : { effort: "medium" });
    expect(traceModelIo).toHaveBeenCalledWith(expect.objectContaining({
      event: "provider.response", response: expect.objectContaining({
        decoded: expect.objectContaining({ text: functionArguments, thinking: enabled ? summary : "" }),
      }),
    }));
  });
});

test("shared ChatGPT transport does not expose summaries even with a summary-shaped upstream payload", async () => {
  const requestBody = request(true);
  requestBody.modelPolicy!.providers!.test.type = "openai-chatgpt";
  const result = await invokeOpenAIResponses({
    endpoint: "raw", requestBody, invocation: resolveModelInvocation(requestBody),
    fetchImpl: async () => new Response(sse(events)),
  }, { url: "https://fixture.test/responses", accessToken: "fixture-only",
    payload: { reasoning: { summary: "auto" } } });
  expect(result).toMatchObject({ kind: "raw", body: { thinking: "" } });
});

test("a summary-unsupported response remains an explicit provider error without retry or extra call", async () => {
  vi.stubEnv("NATIVE_TEST_KEY", "fixture-only");
  const requestBody = request(true);
  const error = { error: { type: "invalid_request_error", code: "unsupported_parameter",
    param: "reasoning.summary", message: "Summary unsupported for this model" } };
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(error, { status: 400 }));
  const result = await createOpenAIProviderAdapter().invoke({
    endpoint: "raw", requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl,
  });
  expect(result).toMatchObject({ kind: "error", statusCode: 400 });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

test("existing effort compatibility retry preserves the requested summary", async () => {
  vi.stubEnv("NATIVE_TEST_KEY", "fixture-only");
  const requestBody = request(true);
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ error: { type: "invalid_request_error", code: "unsupported_value",
      param: "reasoning.effort", message: "Unsupported effort" } }, { status: 400 }))
    .mockImplementationOnce(async () => new Response(sse(events)));
  const result = await createOpenAIProviderAdapter().invoke({
    endpoint: "raw", requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl,
  });
  expect(result).toMatchObject({ kind: "raw", body: { text: functionArguments, thinking: summary } });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).reasoning).toEqual({ summary: "auto" });
});
