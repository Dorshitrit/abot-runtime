import { describe, expect, test } from "vitest";
import { OpenAIResponsesStreamNormalizer } from "./stream-normalizer.js";
import { collectOpenAIResponsesStream, forwardOpenAIResponsesStream } from "./stream.js";

const answer = '{"action":"run_capability","capability":"filesystem"}';
const preamble = "I will inspect the files first.";

function item(index: number, phase?: string, type = "response.output_item.added") {
  return { type, output_index: index,
    item: { id: `msg-${index}`, type: "message", role: "assistant", phase } };
}

function delta(index: number, text: string) {
  return { type: "response.output_text.delta", item_id: `msg-${index}`,
    output_index: index, delta: text };
}

function completed(output?: unknown[]) {
  return { type: "response.completed", response: { output } };
}

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events.map((event) =>
    `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`,
  ).join(""));
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

function phases() {
  return [item(0, "commentary"), delta(0, preamble), item(0, "commentary", "response.output_item.done"),
    item(1, "final_answer"), delta(1, answer), item(1, "final_answer", "response.output_item.done"), completed()];
}

describe("OpenAI structured message phases", () => {
  test("streams only the labelled final answer and diagnoses the actual selection", () => {
    const diagnostics: unknown[] = [];
    const normalizer = new OpenAIResponsesStreamNormalizer({ structuredOutput: true,
      onMessageOutputDiagnostic: (value) => diagnostics.push(value) });
    expect(normalizer.consume(item(0, "commentary"))).toEqual([]);
    expect(normalizer.consume(delta(0, preamble))).toEqual([]);
    expect(normalizer.consume(item(1, "final_answer"))).toEqual([]);
    expect(normalizer.consume(delta(1, answer))).toEqual([{ type: "content", text: answer }]);
    expect(normalizer.consume(completed())).toEqual([{ type: "done", done: true }]);
    expect(diagnostics).toMatchObject([{ selectedOutput: { itemId: "msg-1", phase: "final_answer" },
      ignoredOutputCount: 1, sampledIgnoredOutputs: [{ itemId: "msg-0", phase: "commentary" }] }]);
    expect(normalizer.finish()).toEqual([]);
    expect(normalizer.end()).toEqual([]);
  });

  test.each(["response.output_item.added", "response.output_item.done", "response.completed"])(
    "holds unclassified text until phase arrives in %s", (eventType) => {
      const normalizer = new OpenAIResponsesStreamNormalizer({ structuredOutput: true });
      expect(normalizer.consume(delta(0, preamble))).toEqual([]);
      expect(normalizer.consume(delta(1, answer.slice(0, 20)))).toEqual([]);
      expect(normalizer.consume(delta(1, answer.slice(20)))).toEqual([]);
      const events = eventType === "response.completed"
        ? [completed([item(0, "commentary").item, item(1, "final_answer").item])]
        : [item(0, "commentary", eventType), item(1, "final_answer", eventType), completed()];
      expect(events.flatMap((event) => normalizer.consume(event))).toEqual([
        { type: "content", text: answer.slice(0, 20) },
        { type: "content", text: answer.slice(20) }, { type: "done", done: true },
      ]);
    },
  );

  test("binds deltas that use only an index or only an item ID to their metadata", () => {
    const normalizer = new OpenAIResponsesStreamNormalizer({ structuredOutput: true });
    normalizer.consume(item(0, "commentary"));
    expect(normalizer.consume({ type: "response.output_text.delta", output_index: 0, delta: preamble })).toEqual([]);
    expect(normalizer.consume({ type: "response.output_text.delta", output_index: 1, delta: answer.slice(0, 20) })).toEqual([]);
    expect(normalizer.consume(item(1, "final_answer"))).toEqual([{ type: "content", text: answer.slice(0, 20) }]);
    expect(normalizer.consume({ type: "response.output_text.delta", item_id: "msg-1", delta: answer.slice(20) }))
      .toEqual([{ type: "content", text: answer.slice(20) }]);
  });

  test("keeps messages separate when commentary and final deltas are interleaved", async () => {
    const events = [item(0, "commentary"), item(1, "final_answer"),
      delta(1, answer.slice(0, 10)), delta(0, preamble), delta(1, answer.slice(10)), completed()];
    await expect(collectOpenAIResponsesStream(sse(events), { structuredOutput: true }))
      .resolves.toEqual({ text: answer, thinking: "" });
  });

  test("does not select parseable commentary or silently repair an invalid final answer", async () => {
    const events = [item(0, "commentary"), delta(0, answer),
      item(1, "final_answer"), delta(1, "invalid final JSON"), completed()];
    await expect(collectOpenAIResponsesStream(sse(events), { structuredOutput: true }))
      .resolves.toEqual({ text: "invalid final JSON", thinking: "" });
  });

  test("selects the first explicit final message without concatenating another final", async () => {
    const events = [item(0), delta(0, "unclassified"), item(1, "final_answer"), delta(1, answer),
      item(2, "final_answer"), delta(2, "different answer"), completed()];
    await expect(collectOpenAIResponsesStream(sse(events), { structuredOutput: true }))
      .resolves.toEqual({ text: answer, thinking: "" });
  });

  test("keeps legacy first-text selection even when item metadata arrives in another order", async () => {
    const events = [item(1), item(0), delta(0, answer), delta(1, "different answer"), completed()];
    await expect(collectOpenAIResponsesStream(sse(events), { structuredOutput: true }))
      .resolves.toEqual({ text: answer, thinking: "" });
  });

  test.each([undefined, null])("keeps responses with phase=%s compatible", async (phase) => {
    const metadata = item(0).item;
    const events = [{ type: "response.output_item.added", output_index: 0, item: { ...metadata, phase } },
      delta(0, answer), delta(1, "other"), completed()];
    await expect(collectOpenAIResponsesStream(sse(events), { structuredOutput: true }))
      .resolves.toEqual({ text: answer, thinking: "" });
  });

  test.each(["completed", "incomplete", "done", "eof"])("rejects commentary-only %s responses", async (ending) => {
    const events: unknown[] = [item(0, "commentary"), delta(0, answer)];
    if (ending === "completed") events.push(completed());
    if (ending === "incomplete") events.push({ type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } } });
    if (ending === "done") events.push("[DONE]");
    const error = ending === "done" || ending === "eof"
      ? "openai response not completed" : "openai structured response missing final_answer";
    await expect(collectOpenAIResponsesStream(sse(events), { structuredOutput: true }))
      .rejects.toThrow(error);
    const forwarded: unknown[] = [];
    await forwardOpenAIResponsesStream(sse(events), { emit: (event) => forwarded.push(event) }, { structuredOutput: true });
    expect(forwarded).toEqual([{ type: "error", error }]);
  });

  test("retains max-output termination and usage for a partial final answer", async () => {
    const events = [item(0, "commentary"), delta(0, preamble), item(1, "final_answer"), delta(1, "{\"action\":"),
      { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } }];
    await expect(collectOpenAIResponsesStream(sse(events), { structuredOutput: true })).resolves.toEqual({
      text: "{\"action\":", thinking: "", doneReason: "max_output_tokens",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });
  });

  test("propagates provider errors without releasing unclassified text", async () => {
    const events = [delta(0, preamble), { type: "error", error: { message: "provider failure" } }, "[DONE]"];
    await expect(collectOpenAIResponsesStream(sse(events), { structuredOutput: true })).rejects.toThrow("provider failure");
    const forwarded: unknown[] = [];
    await forwardOpenAIResponsesStream(sse(events), { emit: (event) => forwarded.push(event) }, { structuredOutput: true });
    expect(forwarded).toEqual([{ type: "error", error: "provider failure" }]);
  });

  test("rejects valid unidentified JSON without response completion", async () => {
    const deltas = [{ type: "response.output_text.delta", delta: answer.slice(0, 12) },
      { type: "response.output_text.delta", delta: answer.slice(12) }];
    for (const events of [deltas, [...deltas, "[DONE]"]]) {
      await expect(collectOpenAIResponsesStream(sse(events), { structuredOutput: true }))
        .rejects.toThrow("openai response not completed");
      const forwarded: unknown[] = [];
      await forwardOpenAIResponsesStream(sse(events), { emit: (event) => forwarded.push(event) }, { structuredOutput: true });
      expect(forwarded).toEqual([{ type: "error", error: "openai response not completed" }]);
    }
  });

  test("preserves ordinary text streaming including labelled messages", async () => {
    await expect(collectOpenAIResponsesStream(sse(phases())))
      .resolves.toEqual({ text: preamble + answer, thinking: "" });
    const normalizer = new OpenAIResponsesStreamNormalizer({});
    expect(normalizer.consume(delta(0, preamble))).toEqual([{ type: "content", text: preamble }]);
  });
});
