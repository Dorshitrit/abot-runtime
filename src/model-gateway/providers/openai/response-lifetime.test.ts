import { describe, expect, test, vi } from "vitest";
import { bindOpenAIResponseLifetime } from "./response-lifetime.js";
import { collectOpenAIResponsesStream, forwardOpenAIResponsesStream } from "./stream.js";
import { OpenAISseDataDecoder } from "./sse-data.js";
import type { ModelGatewayEvent } from "../../types.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const frame = (event: unknown, separator = "\n") => `data: ${JSON.stringify(event)}${separator}${separator}`;

function openResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const upstream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
  return { controller, cancel, upstream, response: bindOpenAIResponseLifetime(new Response(upstream)) };
}

describe("OpenAI response lifetime", () => {
  test.each(["\n", "\r\n", "\r"])("frames split at every byte with %j preserve text, usage and EOF", async (separator) => {
    const fixture = openResponse();
    const text = frame({ type: "response.output_text.delta", delta: "שלום 🍀" }, separator)
      + frame({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }, separator);
    const result = collectOpenAIResponsesStream(fixture.response.body!);
    for (const byte of bytes("\uFEFF" + text)) fixture.controller.enqueue(new Uint8Array([byte]));
    await expect(result).resolves.toEqual({ text: "שלום 🍀", thinking: "", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } });
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.upstream.locked).toBe(false);
  });

  test.each([
    [{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }, { text: "answer", thinking: "", doneReason: "max_output_tokens" }],
  ])("retains the existing terminal meaning for %j", async (terminal, expected) => {
    const fixture = openResponse();
    const result = collectOpenAIResponsesStream(fixture.response.body!);
    fixture.controller.enqueue(bytes(frame({ type: "response.output_text.delta", delta: "answer" })
      + frame(terminal)));
    await expect(result).resolves.toEqual(expected);
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  test.each([
    ["[DONE]", "not completed"],
    [{ type: "error", message: "provider failure" }, "provider failure"],
    [{ type: "response.failed", response: { error: { message: "response failed" } } }, "response failed"],
    [{ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } }, "content_filter"],
  ])("keeps terminal failures as errors in chat and raw: %j", async (terminal, message) => {
    for (const mode of ["raw", "chat"]) {
      const fixture = openResponse();
      const events: ModelGatewayEvent[] = [];
      const operation = mode === "raw" ? collectOpenAIResponsesStream(fixture.response.body!)
        : forwardOpenAIResponsesStream(fixture.response.body!, { emit: (event) => events.push(event) });
      fixture.controller.enqueue(bytes(terminal === "[DONE]" ? "data: [DONE]\n\n" : frame(terminal)));
      if (mode === "raw") await expect(operation).rejects.toThrow(message);
      else { await operation; expect(events).toEqual([{ type: "error", error: expect.stringContaining(message) }]); }
      expect(fixture.cancel).toHaveBeenCalledOnce();
    }
  });

  test("a message ending, malformed data or terminal text inside content does not complete the response", async () => {
    const fixture = openResponse();
    const events: ModelGatewayEvent[] = [];
    const operation = forwardOpenAIResponsesStream(fixture.response.body!, { emit: (event) => events.push(event) });
    fixture.controller.enqueue(bytes('data: malformed\n\n' + frame({ type: "response.output_item.done", item: { type: "message", status: "completed" } })
      + frame({ type: "response.output_text.delta", delta: "response.completed [DONE]" })));
    await vi.waitFor(() => expect(events).toEqual([{ type: "content", text: "response.completed [DONE]" }]));
    expect(fixture.cancel).not.toHaveBeenCalled();
    fixture.controller.enqueue(bytes(frame({ type: "response.completed" })));
    await operation;
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("EOF without response completion rejects partial text", async () => {
    const fixture = openResponse();
    fixture.controller.enqueue(bytes(frame({ type: "response.output_text.delta", delta: "partial" })));
    fixture.controller.close();
    await expect(collectOpenAIResponsesStream(fixture.response.body!)).rejects.toThrow("not completed");
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(fixture.upstream.locked).toBe(false);
  });

  test("transport failure and cancellation retain their cause and release the reader", async () => {
    const failed = openResponse();
    const error = new Error("broken transport");
    failed.controller.error(error);
    await expect(failed.response.text()).rejects.toBe(error);
    expect(failed.upstream.locked).toBe(false);
    const cancelled = openResponse();
    const reader = cancelled.response.body!.getReader();
    const pending = reader.read();
    await reader.cancel("caller stopped");
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(cancelled.cancel).toHaveBeenCalledWith("caller stopped");
    expect(cancelled.upstream.locked).toBe(false);
  });

  test("protocol completion is independent of pending or rejected transport cleanup", async () => {
    for (const cancel of [() => new Promise<void>(() => {}), () => Promise.reject(new Error("cleanup failed"))]) {
      const upstream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes(frame({ type: "response.completed" }))); }, cancel,
      });
      await expect(bindOpenAIResponseLifetime(new Response(upstream)).text()).resolves.toContain("response.completed");
      expect(upstream.locked).toBe(false);
    }
  });

  test("HTTP error bodies keep their original identity and evidence", async () => {
    const response = new Response("unauthorized", { status: 401 });
    expect(bindOpenAIResponseLifetime(response)).toBe(response);
    expect(await response.text()).toBe("unauthorized");
  });
});

test("SSE data framing joins lines, ignores metadata and waits for a blank line", () => {
  const decoder = new OpenAISseDataDecoder();
  expect(decoder.accept(bytes(':keepalive\r\nevent: response.completed\r\nid: 2\r\ndata: {"type":\r\ndata: "response.completed"}\r\n'))).toEqual([]);
  expect(decoder.accept(bytes('\r\n'))).toEqual(['{"type":\n"response.completed"}']);
  expect(decoder.accept(bytes('data: [DONE]'))).toEqual([]);
});
