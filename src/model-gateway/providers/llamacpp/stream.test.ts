import { describe, expect, test, vi } from "vitest";
import type { ModelGatewayEvent } from "../../types.js";
import { collectLlamaCppChatStream, forwardLlamaCppChatStream } from "./stream.js";
import { bindLlamaCppResponseLifetime } from "./response-lifetime.js";
import { LlamaCppChatStreamNormalizer } from "./stream-normalizer.js";

function chunk(delta: unknown, finish_reason: unknown = null): string {
  return JSON.stringify({ id: "completion-1", choices: [{ index: 0, delta, finish_reason }] });
}
function stream(frames: string[], split = false): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(frames.map((frame) => `data: ${frame}\r\n\r\n`).join(""));
  return new ReadableStream({ start(controller) {
    if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } });
}
const usage = JSON.stringify({ id: "completion-1", choices: [], usage: {
  prompt_tokens: 20, completion_tokens: 9, total_tokens: 29, prompt_tokens_details: { cached_tokens: 5 },
} });
describe("llama.cpp stream normalization", () => {
  test("normalizes split UTF-8/SSE reasoning, content, finish and trailing usage exactly once", async () => {
    const events: ModelGatewayEvent[] = [];
    await forwardLlamaCppChatStream(stream([
      chunk({ role: "assistant" }), chunk({ reasoning_content: "חושב\n" }),
      chunk({ content: "<think>literal</think>\n" }), chunk({}, "stop"), usage, "[DONE]",
    ], true), { emit: (event) => events.push(event) });
    expect(events).toEqual([
      { type: "thinking", text: "חושב\n" }, { type: "content", text: "<think>literal</think>\n" },
      { type: "done", done: true, doneReason: "stop", usage: { inputTokens: 20, outputTokens: 9, totalTokens: 29, cachedInputTokens: 5 } },
    ]);
  });
  test("reports native truncation without reclassifying it as successful stop", async () => {
    expect(await collectLlamaCppChatStream(stream([chunk({ content: "partial" }), chunk({}, "length"), "[DONE]"])))
      .toEqual({ text: "partial", thinking: "", doneReason: "length" });
  });
  test("reports reasoning token usage only when supplied by the provider", async () => {
    const withReasoning = JSON.stringify({ choices: [], usage: {
      prompt_tokens: 10, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 4 },
    } });
    const result = await collectLlamaCppChatStream(stream([chunk({ reasoning_content: "long text" }), chunk({}, "stop"), withReasoning, "[DONE]"]));
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 7, totalTokens: 17, reasoningTokens: 4 });
  });
  test.each([
    ["eof", [chunk({ content: "partial" })]],
    ["done-without-finish", [chunk({ content: "partial" }), "[DONE]"]],
    ["finish-without-done", [chunk({}, "stop")]],
    ["malformed-json", ["not json"]],
    ["native-error", [JSON.stringify({ error: { message: "private payload" } })]],
    ["tool-call", [chunk({ tool_calls: [{ id: "generated" }] })]],
    ["multiple-choices", [JSON.stringify({ choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] })]],
    ["wrong-choice-index", [JSON.stringify({ choices: [{ index: 1, delta: {} }] })]],
    ["invalid-delta", [chunk({ content: ["unexpected"] })]],
    ["content-after-finish", [chunk({}, "stop"), chunk({ content: "bad" }), "[DONE]"]],
    ["unsupported-finish", [chunk({}, "tool_calls"), "[DONE]"]],
    ["identity-change", [chunk({}), JSON.stringify({ id: "different", choices: [] })]],
    ["duplicate-finish", [chunk({}, "stop"), chunk({}, "stop"), "[DONE]"]],
  ])("rejects %s without emitting a synthetic done", async (_label, frames) => {
    const events: ModelGatewayEvent[] = [];
    await expect(forwardLlamaCppChatStream(stream(frames), { emit: (event) => events.push(event) }))
      .rejects.toThrow("llamacpp_stream_");
    expect(events.some((event) => event.type === "done")).toBe(false);
  });
  test("ignores later transport frames after one protocol completion", () => {
    const normalizer = new LlamaCppChatStreamNormalizer();
    normalizer.consume(chunk({}, "stop"));
    expect(normalizer.consume("[DONE]")).toHaveLength(1);
    expect(normalizer.consume("[DONE]")).toEqual([]);
  });
  test.each([
    ["completion", [chunk({ content: "ok" }), chunk({}, "stop"), usage, "[DONE]"]],
    ["error", [JSON.stringify({ error: { message: "native error" } })]],
    ["malformed", ["bad json"]],
  ])("closes a held-open source at %s before all trace tee branches finish", async (kind, frames) => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(frames.map((frame) => `data: ${frame}\n\n`).join(""))); },
      cancel,
    });
    const response = bindLlamaCppResponseLifetime(new Response(source));
    const traced = response.clone().text();
    if (kind === "completion") expect((await collectLlamaCppChatStream(response.body!)).text).toBe("ok");
    else await expect(collectLlamaCppChatStream(response.body!)).rejects.toThrow("llamacpp_stream_");
    await traced;
    expect(cancel).toHaveBeenCalledOnce();
  });
  test("propagates aborted body errors", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new DOMException("stop", "AbortError")); } });
    await expect(collectLlamaCppChatStream(bindLlamaCppResponseLifetime(new Response(body)).body!))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
