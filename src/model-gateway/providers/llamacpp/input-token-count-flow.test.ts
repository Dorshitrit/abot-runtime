import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { configureDebugLogger, resetDebugLoggerConfig } from "../../../runtime/observability/debug-logger.js";
import { createModelGatewayClient } from "../../client.js";
import { configureModelIoTrace, resetModelIoTraceConfig } from "../../model-io-trace.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import { createChatHandler } from "../../server/chat-handler.js";
import type { GatewayResponse } from "../../server/contracts.js";
import { createInputTokenCountHandler } from "../../server/input-token-count-handler.js";
import { createInputTokenMeasurementStore } from "../../server/input-token-measurements.js";
import type { ModelGatewayPolicyConfig, ModelGatewayRequest } from "../../types.js";
import { estimateProviderEnvelopeInputTokens } from "../envelope-budget.js";
import { buildLlamaCppChatPayload } from "./payload.js";

function response(): GatewayResponse & { body: string } {
  return { body: "", setHeader: vi.fn(), write(chunk) { this.body += chunk; },
    end(chunk = "") { this.body += chunk; } };
}
function policy(): ModelGatewayPolicyConfig {
  return {
    providers: { local: { type: "llamacpp", baseUrl: "http://provider.test" } },
    profiles: { gemma: { provider: "local", model: "counted-gemma", contextWindowTokens: 128,
      supportsThinking: true, generation: { reasoningBudget: { mode: "tokens", tokens: 123 } },
      calibration: { response: { instructions: ["Stage calibration."] } } } },
    defaults: { profileId: "gemma", steps: { "supervisor.response": "response" } },
  };
}

function createFlow() {
  let now = 0;
  let measuredCount = 19;
  let lastCountRequest: ModelGatewayRequest = {};
  const wire: Array<{ url: string; payload: Record<string, unknown> }> = [];
  const modelPolicy = policy();
  const measurements = createInputTokenMeasurementStore({ now: () => now });
  const providerFetch = vi.fn<typeof fetch>(async (url, init) => {
    wire.push({ url: String(url), payload: JSON.parse(String(init?.body)) });
    if (String(url).endsWith("/input_tokens")) return Response.json({ input_tokens: measuredCount });
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const options = { modelPolicy, fetchImpl: providerFetch };
  const countHandler = createInputTokenCountHandler(options, measurements);
  const chatHandler = createChatHandler(options, measurements);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe("http://gateway.test/input-tokens");
    lastCountRequest = JSON.parse(String(init?.body));
    const output = response();
    await countHandler(lastCountRequest, output, { abortSignal: init?.signal ?? undefined });
    return new Response(output.body, { status: output.statusCode ?? 200 });
  }));
  const client = createModelGatewayClient({ baseUrl: "http://gateway.test" });
  const params = {
    provider: "llamacpp", modelPolicy, debugRequestId: "llamacpp-count-flow",
    agentMode: "deep" as const, modelStep: "supervisor.response" as const,
    messages: [{ role: "user" as const, content: "שלום 🧪 ".repeat(128) }],
    format: { type: "json_schema", name: "answer", schema: {
      type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false,
    } },
    abortSignal: new AbortController().signal,
  };
  return {
    client, params, wire, providerFetch, chatHandler, countHandler, measurements,
    get request() { return lastCountRequest; },
    expire() { now += 5 * 60_000 + 1; },
    setCount(value: number) { measuredCount = value; },
  };
}

beforeEach(() => { configureDebugLogger({ enabled: false }); configureModelIoTrace({ enabled: false }); });
afterEach(() => { vi.unstubAllGlobals(); resetDebugLoggerConfig(); resetModelIoTraceConfig(); });

describe("llama.cpp counted admission and final dispatch", () => {
  test("recounts after expiry and refreshes the exact final-envelope measurement", async () => {
    const flow = createFlow();
    expect((await flow.client.countInputTokens(flow.params))?.inputTokens).toBe(19);
    const binding = { requestBody: flow.request, invocation: resolveModelInvocation(flow.request) };
    flow.expire();
    expect(flow.measurements.resolve(binding)).toBeUndefined();
    flow.setCount(29);
    expect((await flow.client.countInputTokens(flow.params))?.inputTokens).toBe(29);
    expect(flow.measurements.resolve(binding)?.inputTokens).toBe(29);
    const output = response();
    await flow.chatHandler(flow.request, output);
    expect(flow.wire.map(({ url }) => url)).toEqual([
      "http://provider.test/v1/chat/completions/input_tokens",
      "http://provider.test/v1/chat/completions/input_tokens",
      "http://provider.test/v1/chat/completions",
    ]);
    expect(flow.wire[2]?.payload).toEqual(flow.wire[1]?.payload);
    expect(estimateProviderEnvelopeInputTokens(flow.wire[2]!.payload)).toBeGreaterThan(128);
    expect(output.body).toContain('"type":"done"');
  });

  test("remeasures changed compaction candidates with their own messages", async () => {
    const flow = createFlow();
    await flow.client.countInputTokens(flow.params);
    const original = flow.request;
    flow.setCount(7);
    const compactedMessages = [{ role: "user" as const, content: "Compacted exact evidence." }];
    expect((await flow.client.countInputTokens({ ...flow.params, messages: compactedMessages }))?.inputTokens).toBe(7);
    expect(flow.wire[0]?.payload.messages).not.toEqual(flow.wire[1]?.payload.messages);
    expect(flow.wire[1]?.payload.messages).toEqual([
      { role: "system", content: "Stage calibration." }, ...compactedMessages,
    ]);
    const invocation = resolveModelInvocation(flow.request);
    expect(flow.measurements.resolve({ requestBody: flow.request, invocation })?.inputTokens).toBe(7);
    expect(flow.measurements.resolve({ requestBody: original, invocation })?.inputTokens).toBe(19);
    const output = response();
    await flow.chatHandler(flow.request, output);
    expect(flow.wire[2]?.payload).toEqual(flow.wire[1]?.payload);
  });

  test.each(["expired", "changed format"])("retains final-guard estimation for %s measurements without claiming an exact match", async (reason) => {
    const flow = createFlow();
    await flow.client.countInputTokens(flow.params);
    let requestBody = flow.request;
    if (reason === "expired") flow.expire();
    if (reason === "changed format") requestBody = { ...requestBody, format: "json" };
    const output = response();
    await flow.chatHandler(requestBody, output);
    expect(flow.wire).toHaveLength(1);
    expect(output.statusCode).toBe(400);
    expect(output.body).toBe("model_context_window_exceeded");
  });

  test("rejects a measured physical overflow before generation", async () => {
    const flow = createFlow();
    flow.setCount(128);
    await flow.client.countInputTokens(flow.params);
    const payload = buildLlamaCppChatPayload({ endpoint: "chat", requestBody: flow.request,
      invocation: resolveModelInvocation(flow.request) });
    expect(flow.measurements.resolve({ requestBody: flow.request, invocation: resolveModelInvocation(flow.request) })?.inputTokens).toBe(128);
    expect(payload.messages).toEqual(flow.wire[0]?.payload.messages);
    const output = response();
    await flow.chatHandler(flow.request, output);
    expect(flow.wire).toHaveLength(1);
    expect(output.body).toBe("model_context_window_exceeded");
  });

  test("propagates cancellation to the active native count without recording a measurement", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let upstreamSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal!.addEventListener("abort", () => reject(upstreamSignal!.reason), { once: true });
      });
    });
    const modelPolicy = policy();
    const requestBody: ModelGatewayRequest = { text: "Count only.", modelPolicy };
    const measurements = createInputTokenMeasurementStore();
    const output = response();
    const running = createInputTokenCountHandler({ modelPolicy, fetchImpl }, measurements)(
      requestBody, output, { abortSignal: controller.signal },
    );
    await started;
    controller.abort(new DOMException("count cancelled", "AbortError"));
    await running;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(output.body).toBe("");
    expect(measurements.resolve({ requestBody, invocation: resolveModelInvocation(requestBody) })).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
