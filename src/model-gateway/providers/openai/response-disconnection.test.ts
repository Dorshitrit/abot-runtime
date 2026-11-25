import { afterEach, describe, expect, test, vi } from "vitest";
import { isProviderStreamDisconnectionError, PROVIDER_STREAM_DISCONNECTION } from "../../protocol/provider-stream-disconnection.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import { traceModelIo } from "../../observability/trace-store.js";
import type { ModelGatewayEvent, ModelGatewayRequest } from "../../types.js";
import { createOpenAIProviderAdapter } from "./adapter.js";
import { createChatGptProviderAdapter } from "../openai-chatgpt/adapter.js";
import { accountRef } from "../openai-chatgpt/__tests__/fixture.js";
import { completedFunction, frame, functionCall, nativeRequest } from "./__tests__/native-function-fixture.js";
import { OpenAIResponseDisconnectionEvidence } from "./response-disconnection.js";
import { forwardOpenAIResponsesStream } from "./stream.js";

vi.mock("../../observability/trace-store.js", () => ({
  isModelIoTraceEnabled: () => true,
  traceModelIo: vi.fn(async () => {}),
}));

const created = { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } };
const added = { type: "response.output_item.added", output_index: 0,
  item: { ...functionCall, status: "in_progress", arguments: "" } };
const delta = { type: "response.function_call_arguments.delta", item_id: functionCall.id, output_index: 0, delta: '{"decision":' };
const prefix = [created, added, delta].map(frame).join("");

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

async function invoke(provider: "openai" | "openai-chatgpt", endpoint: "chat" | "raw", body: string | ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal) {
  vi.stubEnv("NATIVE_TEST_KEY", "fixture-only");
  const requestBody: ModelGatewayRequest = {
    ...nativeRequest,
    modelPolicy: {
      ...nativeRequest.modelPolicy!,
      providers: { test: provider === "openai"
        ? { type: provider, apiKeyEnv: "NATIVE_TEST_KEY" }
        : { type: provider, settings: { accountRef } } },
    },
  };
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  }));
  const adapter = provider === "openai" ? createOpenAIProviderAdapter()
    : createChatGptProviderAdapter({ getAccessToken: async () => "fixture-only" });
  const events: ModelGatewayEvent[] = [];
  const result = await adapter.invoke({
    endpoint, requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl, abortSignal,
  }).then(async (result) => {
    if (result.kind === "chat") await result.stream({ emit: (event) => events.push(event) });
    return result;
  }).catch((error: unknown) => error);
  return { result, events, fetchImpl };
}

describe.each(["openai", "openai-chatgpt"] as const)("%s provider stream provenance", (provider) => {
  test.each(["chat", "raw"] as const)("%s classifies observed upstream EOF and preserves its complete byte trace", async (endpoint) => {
    const body = prefix + frame({ ...delta, delta: "שלום".repeat(12_000) });
    const { result, events, fetchImpl } = await invoke(provider, endpoint, body);
    expect(fetchImpl).toHaveBeenCalledOnce();
    if (endpoint === "chat") {
      expect(events).toEqual([{ type: "error", error: "openai function response not completed",
        providerDisconnection: PROVIDER_STREAM_DISCONNECTION }]);
    } else {
      expect(isProviderStreamDisconnectionError(result)).toBe(true);
    }
    expect(traceModelIo).toHaveBeenCalledWith(expect.objectContaining({
      event: "provider.response", response: expect.objectContaining({
        body, decodeError: expect.objectContaining({ message: expect.stringContaining("not completed") }),
      }),
    }));
  });

  test.each([
    ["delta without response identity", frame(delta)],
    ["DONE", prefix + "data: [DONE]\n\n"],
    ["malformed frame", prefix + "data: not-json\n\n"],
    ["invalid event", prefix + "data: null\n\n"],
    ["changed response identity", prefix + frame({ ...created, response: { id: "other", status: "in_progress" } })],
    ["explicit provider error", prefix + frame({ type: "error", message: "model_provider_stream_disconnected",
      providerDisconnection: PROVIDER_STREAM_DISCONNECTION })],
    ["provider failure", prefix + frame({ type: "response.failed", response: { status: "failed", error: { message: "failed" } } })],
    ["output limit", prefix + frame({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })],
    ["refusal", prefix + frame({ type: "response.refusal.delta", delta: "refused" })],
    ["invalid completion", prefix + frame({ type: "response.completed", response: { status: "in_progress" } })],
  ])("%s does not acquire disconnection provenance", async (_name, body) => {
    for (const endpoint of ["chat", "raw"] as const) {
      const { result, events, fetchImpl } = await invoke(provider, endpoint, body);
      expect(isProviderStreamDisconnectionError(result)).toBe(false);
      expect(events.every((event) => !Object.hasOwn(event, "providerDisconnection"))).toBe(true);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  test("valid terminal completion is unchanged", async () => {
    const { result, events } = await invoke(provider, "chat", prefix + frame(completedFunction));
    expect(isProviderStreamDisconnectionError(result)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  test.each(["chat", "raw"] as const)("%s carries an actual upstream socket failure through the adapter", async (endpoint) => {
    const failure = new TypeError("terminated", { cause: Object.assign(new Error("socket"), { code: "UND_ERR_SOCKET" }) });
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure); } });
    const { result, events, fetchImpl } = await invoke(provider, endpoint, body);
    if (endpoint === "chat") {
      expect(events).toEqual([{ type: "error", error: "terminated", providerDisconnection: PROVIDER_STREAM_DISCONNECTION }]);
    } else expect(isProviderStreamDisconnectionError(result)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(traceModelIo).toHaveBeenCalledWith(expect.objectContaining({ event: "provider.failure", stage: "response.capture" }));
  });
});

test.each(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"])("an upstream reader %s carries typed disconnection evidence", async (code) => {
  const original = new TypeError("connection terminated", { cause: Object.assign(new Error("socket"), { code }) });
  const reader = new ReadableStream<Uint8Array>({ start(controller) { controller.error(original); } }).getReader();
  const error = await new OpenAIResponseDisconnectionEvidence().read(reader).catch((value: unknown) => value);
  expect(isProviderStreamDisconnectionError(error)).toBe(true);
  expect((error as Error).message).toBe(original.message);
  reader.releaseLock();
});

test.each([
  new TypeError("connection terminated"),
  Object.assign(new Error("timeout"), { code: "UND_ERR_BODY_TIMEOUT" }),
  Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
  Object.assign(new Error("connection"), { code: "ECONNREFUSED" }),
  Object.assign(new Error("aborted"), { name: "AbortError", code: "ECONNRESET" }),
])("unclassified reads and timeouts preserve their original error: %j", async (original) => {
  const reader = new ReadableStream<Uint8Array>({ start(controller) { controller.error(original); } }).getReader();
  await expect(new OpenAIResponseDisconnectionEvidence().read(reader)).rejects.toBe(original);
  reader.releaseLock();
});

test("cancellation wins over EOF and an upstream socket error", async () => {
  const controller = new AbortController();
  const evidence = new OpenAIResponseDisconnectionEvidence(controller.signal);
  evidence.observeEvent(created);
  evidence.recordUpstreamEof();
  controller.abort();
  expect(() => evidence.assertNotDisconnected()).not.toThrow();
  const original = Object.assign(new Error("socket"), { code: "ECONNRESET" });
  const reader = new ReadableStream<Uint8Array>({ start(stream) { stream.error(original); } }).getReader();
  await expect(evidence.read(reader)).rejects.toBe(original);
  reader.releaseLock();
});

test("local sink faults are neither swallowed nor classified as provider disconnects", async () => {
  const failure = Object.assign(new Error("local sink failed"), { code: "ECONNRESET" });
  await expect(forwardOpenAIResponsesStream(new Response(frame({ type: "response.output_text.delta", delta: "partial" })).body!, {
    emit() { throw failure; },
  })).rejects.toBe(failure);
  expect(isProviderStreamDisconnectionError(failure)).toBe(false);
});
