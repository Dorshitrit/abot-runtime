import { describe, expect, test } from "vitest";
import { captureProviderResponseBody } from "./provider-response-capture.js";
import { ProviderSseDiagnostics } from "./provider-sse-diagnostics.js";

const encoder = new TextEncoder();

function eventStream(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

describe("provider response capture", () => {
  test("preserves the complete UTF-8 body and counts split SSE events", async () => {
    const text = 'event: response.created\r\ndata: {}\r\n\r\ndata: {"type":"response.output_text.delta","delta":"שלום 🌍"}\n\nevent: response.completed\ndata: {}\n\n';
    const bytes = encoder.encode(text);
    const response = eventStream(new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    }));
    const captured = await captureProviderResponseBody(response, Date.now() - 10);
    expect(captured).toMatchObject({ outcome: "completed", body: text });
    expect(captured.stream.bytesReceived).toBe(bytes.length);
    expect(captured.stream.firstChunkAfterMs).toBeGreaterThanOrEqual(10);
    expect(captured.stream.lastChunkAfterMs).toBeGreaterThanOrEqual(captured.stream.firstChunkAfterMs!);
    expect(captured.stream.sse).toMatchObject({
      eventCount: 3,
      eventTypes: { "response.created": 1, "response.output_text.delta": 1, "response.completed": 1 },
    });
  });

  test("preserves bounded partial prefix and tail and the original abort after receiving data", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = eventStream(new ReadableStream({ start(value) { controller = value; } }));
    const capture = captureProviderResponseBody(response, Date.now());
    const first = 'event: response.created\ndata: {}\n\n';
    const tail = 'event: response.output_text.delta\ndata: {"delta":"' + "x".repeat(20_000) + '"}\n\n';
    controller.enqueue(encoder.encode(first));
    await Promise.resolve();
    controller.enqueue(encoder.encode(tail));
    await Promise.resolve();
    const error = new DOMException("test timeout", "AbortError");
    controller.error(error);
    const captured = await capture;
    expect(captured.outcome).toBe("failed");
    if (captured.outcome !== "failed") throw new Error("Expected failure capture");
    expect(captured.error).toBe(error);
    expect(captured.partialBodyPrefix).toBe((first + tail).slice(0, 16_384));
    expect(captured.partialBodyPrefixBytes).toBe(16_384);
    expect(captured.partialBodyPrefixTruncated).toBe(true);
    expect(captured.partialBody).toBe(tail.slice(-16_384));
    expect(captured.partialBodyBytes).toBe(16_384);
    expect(captured.bodyTruncated).toBe(true);
    expect(captured.stream.bytesReceived).toBe(encoder.encode(first + tail).length);
    expect(captured.stream.sse?.eventCount).toBe(2);
  });

  test("distinguishes an empty failed stream from a received partial response", async () => {
    const error = new Error("connection lost");
    const response = eventStream(new ReadableStream({ start(controller) { controller.error(error); } }));
    const captured = await captureProviderResponseBody(response, Date.now());
    expect(captured).toMatchObject({
      outcome: "failed", error, partialBody: "", partialBodyBytes: 0, bodyTruncated: false,
      partialBodyPrefix: "", partialBodyPrefixBytes: 0, partialBodyPrefixTruncated: false,
      stream: { bytesReceived: 0, chunkCount: 0, firstChunkAfterMs: null, lastChunkAfterMs: null },
    });
  });

  test.each(["שלום 🌍", "x".repeat(16_384)])("keeps an untruncated prefix when the failed body fits (%#)", async (text) => {
    const source = encoder.encode(text);
    let offset = 0;
    const error = new Error("connection lost");
    const response = eventStream(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < source.length) {
          controller.enqueue(source.slice(offset, offset + 1));
          offset += 1;
        } else controller.error(error);
      },
    }));
    const captured = await captureProviderResponseBody(response, Date.now());
    expect(captured).toMatchObject({
      outcome: "failed", error,
      partialBodyPrefix: text, partialBodyPrefixBytes: source.length, partialBodyPrefixTruncated: false,
      partialBody: text, partialBodyBytes: source.length, bodyTruncated: false,
    });
  });

  test("retains non-SSE bodies without interpreting their content as events", async () => {
    const captured = await captureProviderResponseBody(new Response('{"type":"text"}'), Date.now());
    expect(captured).toMatchObject({ outcome: "completed", body: '{"type":"text"}' });
    expect(captured.stream).not.toHaveProperty("sse");
  });
});

describe("bounded provider SSE metadata", () => {
  test("records event timing while bounding event types and recent event history", () => {
    const capture = new ProviderSseDiagnostics();
    for (let i = 0; i < 100; i += 1) capture.observe(`event: type-${i}\ndata: {}\n\n`, i * 10);
    const result = capture.snapshot();
    expect(result.eventCount).toBe(100);
    expect(Object.keys(result.eventTypes)).toHaveLength(33);
    expect(result.eventTypes["(other)"]).toBe(68);
    expect(result.recentEvents).toHaveLength(32);
    expect(result.recentEvents[0]).toEqual({ type: "type-68", afterMs: 680 });
    expect(result.recentEvents.at(-1)).toEqual({ type: "type-99", afterMs: 990 });
  });

  test("skips oversized diagnostic lines and continues with later events", () => {
    const capture = new ProviderSseDiagnostics();
    capture.observe('event: response.created\ndata: ' + "x".repeat(40_000), 10);
    capture.observe('\n\nevent: response.completed\ndata: {}\n\n', 20);
    expect(capture.snapshot()).toMatchObject({
      eventCount: 2, oversizedLineCount: 1,
      eventTypes: { "response.created": 1, "response.completed": 1 },
    });
  });
});
