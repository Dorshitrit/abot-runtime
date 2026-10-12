import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../invocation-policy.js";
import { fetchProviderWithTrace } from "./provider-trace.js";
import { traceModelIo } from "./trace-store.js";

vi.mock("./trace-store.js", () => ({
  isModelIoTraceEnabled: () => true,
  traceModelIo: vi.fn(async () => {}),
}));
beforeEach(() => vi.clearAllMocks());

const invocation = resolveModelInvocation({
  modelPolicy: {
    providers: { openai: { type: "openai" } },
    profiles: { test: { provider: "openai", model: "fixture", contextWindowTokens: 32768 } },
    defaults: { profileId: "test" },
  },
});

async function tracedResponse(response: Response, decodeResponse: (body: ReadableStream<Uint8Array>) => Promise<{ text: string; thinking: string }>, endpoint: "chat" | "raw" = "chat") {
  return fetchProviderWithTrace({
    endpoint, requestBody: { modelStep: "execution.decision", debugRequestId: "request-1" },
    invocation, fetchImpl: async () => response, url: "http://provider.test/responses",
    headers: { Authorization: "Bearer never-log-this" }, payload: { model: "fixture" }, decodeResponse,
  });
}

describe("provider partial response tracing", () => {
  test("records a failed body without waiting for a pending diagnostic decoder", async () => {
    let finishDecode!: (value: { text: string; thinking: string }) => void;
    const decoded = new Promise<{ text: string; thinking: string }>((resolve) => { finishDecode = resolve; });
    const error = new Error("upstream failed");
    const response = new Response(new ReadableStream({ start(controller) { controller.error(error); } }));
    const result = await tracedResponse(response, () => decoded);
    try {
      await expect(result.response.text()).rejects.toThrow("upstream failed");
      await vi.waitFor(() => expect(traceModelIo).toHaveBeenLastCalledWith(expect.objectContaining({
        event: "provider.failure", stage: "response.capture", error: { name: "Error", message: "upstream failed" },
      })));
      await result.responseTrace;
    } finally {
      finishDecode({ text: "", thinking: "" });
      await result.responseTrace;
    }
  });

  test.each([
    ["chat", 20], ["chat", 40_000], ["raw", 20], ["raw", 40_000],
  ] as const)("keeps bounded failure evidence and the consumer error for %s with %i payload bytes", async (endpoint, payloadBytes) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let sawDecodedChunk!: () => void;
    const decodedChunk = new Promise<void>((resolve) => { sawDecodedChunk = resolve; });
    const response = new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
    }), { headers: { "content-type": "text/event-stream" } });
    const result = await tracedResponse(response, async (body) => {
      const reader = body.getReader();
      await reader.read();
      sawDecodedChunk();
      await reader.read();
      return { text: "", thinking: "" };
    }, endpoint);
    expect(result.response).toBe(response);
    const consumer = result.response.body!.getReader();
    const chunk = Buffer.from('event: response.output_text.delta\ndata: {"delta":"' + "x".repeat(payloadBytes) + '"}\n\n');
    controller.enqueue(chunk);
    expect((await consumer.read()).value).toEqual(chunk);
    await decodedChunk;
    const error = new DOMException("test timeout", "AbortError");
    controller.error(error);
    await expect(consumer.read()).rejects.toBe(error);
    await result.responseTrace;
    const events = vi.mocked(traceModelIo).mock.calls.map(([event]) => event);
    expect(events.map((event) => event.event)).toEqual(["provider.request", "provider.failure"]);
    expect(events[1]).toMatchObject({
      invocationId: events[0].invocationId, requestId: "request-1", stage: "response.capture",
      error: { name: "AbortError" },
      response: {
        status: 200, partialBody: chunk.subarray(-16_384).toString("utf8"),
        partialBodyBytes: Math.min(chunk.length, 16_384), bodyTruncated: chunk.length > 16_384,
        partialBodyPrefix: chunk.subarray(0, 16_384).toString("utf8"),
        partialBodyPrefixBytes: Math.min(chunk.length, 16_384),
        partialBodyPrefixTruncated: chunk.length > 16_384,
        stream: { bytesReceived: chunk.length, sse: { eventCount: 1 } },
      },
    });
    expect(JSON.stringify(events)).not.toContain("never-log-this");
  });

  test("keeps successful body and decoded output unchanged while adding diagnostics", async () => {
    const text = 'event: response.completed\ndata: {}\n\n';
    const response = new Response(text, { headers: { "content-type": "text/event-stream" } });
    const result = await tracedResponse(response, async (body) => ({
      text: await new Response(body).text(), thinking: "",
    }));
    expect(await result.response.text()).toBe(text);
    await result.responseTrace;
    expect(traceModelIo).toHaveBeenLastCalledWith(expect.objectContaining({
      event: "provider.response",
      response: expect.objectContaining({
        body: text, decoded: { text, thinking: "" },
        stream: expect.objectContaining({ sse: expect.objectContaining({ eventCount: 1 }) }),
      }),
    }));
    const event = vi.mocked(traceModelIo).mock.calls.at(-1)![0];
    expect(event.response).not.toHaveProperty("partialBodyPrefix");
    expect(event.response).not.toHaveProperty("partialBody");
  });
});
