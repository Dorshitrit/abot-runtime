import { describe, expect, test } from "vitest";
import { OpenAIResponsesStreamNormalizer } from "./stream-normalizer.js";
import { collectOpenAIResponsesStream, forwardOpenAIResponsesStream } from "./stream.js";
import { completedFunction, functionArguments, functionCall, sse } from "./__tests__/native-function-fixture.js";

const enabled = { reasoningSummary: true };
const identity = { item_id: "rs_1", output_index: 0, summary_index: 0 };
const summary = "Compare the evidence before answering.";
const delta = (text: string, sequence = 1, ids = identity) => ({
  type: "response.reasoning_summary_text.delta", ...ids, sequence_number: sequence, delta: text,
});
const textDone = (text = summary, ids = identity) => ({
  type: "response.reasoning_summary_text.done", ...ids, text,
});
const partDone = (text = summary, ids = identity) => ({
  type: "response.reasoning_summary_part.done", ...ids, part: { type: "summary_text", text },
});
const reasoningItem = (text = summary) => ({
  type: "reasoning", id: identity.item_id, summary: [{ type: "summary_text", text }],
});
const completed = (output: unknown[] = []) => ({ type: "response.completed", response: { status: "completed", output } });
const content = (text = "The answer.") => ({ type: "response.output_text.delta", delta: text });
const textOf = (events: { type: string; text?: string }[], kind: string) =>
  events.filter((event) => event.type === kind).map((event) => event.text).join("");

describe("OpenAI reasoning summary streaming", () => {
  test("emits reasoning during an open stream before any answer or completion", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let observe!: () => void;
    const observed = new Promise<void>((resolve) => { observe = resolve; });
    const events: { type: string; text?: string }[] = [];
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const stream = forwardOpenAIResponsesStream(body, { emit(event) {
      events.push(event);
      if (event.type === "thinking") observe();
    } }, enabled);
    const enqueue = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    enqueue(delta(summary));
    await observed;
    expect(events).toEqual([{ type: "thinking", text: summary }]);
    enqueue(textDone());
    enqueue(content());
    enqueue(completed());
    controller.close();
    await stream;
    expect(events).toEqual([
      { type: "thinking", text: summary }, { type: "content", text: "The answer." },
      { type: "done", done: true, doneReason: null },
    ]);
  });

  test("deduplicates sequence replay and every completed summary representation", async () => {
    const events = [delta(summary.slice(0, 12), 1), delta(summary.slice(0, 12), 1),
      delta(summary.slice(12), 2), textDone(), partDone(),
      { type: "response.output_item.done", output_index: 0, item: reasoningItem() },
      content(), completed([reasoningItem()])];
    await expect(collectOpenAIResponsesStream(sse(events), enabled))
      .resolves.toEqual({ thinking: summary, text: "The answer." });
    const forwarded: { type: string; text?: string }[] = [];
    await forwardOpenAIResponsesStream(sse(events), { emit: (event) => forwarded.push(event) }, enabled);
    expect(textOf(forwarded, "thinking")).toBe(summary);
    expect(textOf(forwarded, "content")).toBe("The answer.");
  });

  test.each(["text", "part", "item", "response"])("recovers a %s snapshot without duplicating its streamed prefix", async (kind) => {
    const snapshot = {
      text: textDone(), part: partDone(),
      item: { type: "response.output_item.done", output_index: 0, item: reasoningItem() },
      response: completed([reasoningItem()]),
    }[kind]!;
    for (const prefix of [[], [delta(summary.slice(0, 10))]]) {
      await expect(collectOpenAIResponsesStream(sse([...prefix, snapshot, completed()]), enabled))
        .resolves.toEqual({ thinking: summary, text: "" });
    }
  });

  test("preserves parts and items independently with readable boundaries", async () => {
    const second = { ...identity, summary_index: 1 };
    const third = { item_id: "rs_2", output_index: 2, summary_index: 0 };
    const events = [delta("First", 1), textDone("First"), delta("Second", 2, second),
      partDone("Second", second), delta("Third", 3, third), textDone("Third", third), completed()];
    await expect(collectOpenAIResponsesStream(sse(events), enabled))
      .resolves.toEqual({ thinking: "First\n\nSecond\n\nThird", text: "" });
  });

  test("never treats summary completion as function completion or arguments", () => {
    const normalizer = new OpenAIResponsesStreamNormalizer({ ...enabled, functionOutputName: functionCall.name });
    expect(normalizer.consume(delta('{"decision":"do not execute this"}')))
      .toEqual([{ type: "thinking", text: '{"decision":"do not execute this"}' }]);
    expect(normalizer.consume(textDone('{"decision":"do not execute this"}'))).toEqual([]);
    expect(normalizer.hasTerminated).toBe(false);
    expect(normalizer.consume(content("not the function"))).toEqual([]);
    expect(normalizer.consume(completedFunction)).toEqual([
      { type: "content", text: functionArguments },
      { type: "done", done: true, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    ]);
  });

  test("keeps structured final text selection independent of summaries", async () => {
    const final = { type: "message", id: "answer", phase: "final_answer" };
    const events = [delta(summary), textDone(),
      { type: "response.output_item.added", output_index: 1, item: final },
      { ...content('{"ok":true}'), item_id: "answer", output_index: 1 }, completed([reasoningItem(), final])];
    await expect(collectOpenAIResponsesStream(sse(events), { ...enabled, structuredOutput: true }))
      .resolves.toEqual({ thinking: summary, text: '{"ok":true}' });
  });

  test("disabled summaries and native reasoning remain ignored", async () => {
    const events = [delta(summary), textDone(),
      { type: "response.reasoning_text.delta", ...identity, delta: "private reasoning" }, content(),
      completed([reasoningItem()])];
    await expect(collectOpenAIResponsesStream(sse(events))).resolves.toEqual({ text: "The answer.", thinking: "" });
    const normalizer = new OpenAIResponsesStreamNormalizer(enabled);
    expect(normalizer.consume(events[2])).toEqual([]);
  });

  test.each([undefined, -1, NaN, 0.5, "1"])("ignores malformed summary index %s without affecting answer", (summaryIndex) => {
    const normalizer = new OpenAIResponsesStreamNormalizer(enabled);
    expect(normalizer.consume({ ...delta("bad"), summary_index: summaryIndex })).toEqual([]);
    expect(normalizer.consume(content())).toEqual([{ type: "content", text: "The answer." }]);
  });

  test("rejects conflicting snapshots and ignores late deltas for closed parts", async () => {
    const events = [delta("First"), textDone("wrong prefix"), textDone("First valid suffix"),
      delta("late", 2), partDone("First valid suffix"), completed()];
    await expect(collectOpenAIResponsesStream(sse(events), enabled))
      .resolves.toEqual({ thinking: "First valid suffix", text: "" });
  });

  test("validates a Unicode prefix even across split surrogate pairs", () => {
    const normalizer = new OpenAIResponsesStreamNormalizer(enabled);
    const text = "🙂 שלום";
    const events = [delta(text.slice(0, 1)), delta(text.slice(1, 3), 2), textDone(text), completed()];
    expect(textOf(events.flatMap((event) => normalizer.consume(event)), "thinking")).toBe(text);
  });

  test.each(["error", "failed", "eof"])("partial summary cannot mask %s termination", async (ending) => {
    const tails: Record<string, unknown[]> = {
      error: [{ type: "error", error: { message: "failed upstream" } }],
      failed: [{ type: "response.failed", response: { error: { message: "failed upstream" } } }],
      eof: [],
    };
    const tail = tails[ending];
    const events = [delta(summary), textDone(), ...tail];
    const forwarded: { type: string; text?: string }[] = [];
    await forwardOpenAIResponsesStream(sse(events), { emit: (event) => forwarded.push(event) }, enabled);
    expect(forwarded[0]).toEqual({ type: "thinking", text: summary });
    expect(forwarded.at(-1)).toMatchObject({ type: "error" });
    expect(forwarded.some((event) => event.type === "done")).toBe(false);
    await expect(collectOpenAIResponsesStream(sse(events), enabled)).rejects.toThrow("openai_stream_error");
  });

  test("marks incomplete output and keeps summary separate from answer bytes", async () => {
    const events = [delta(summary), content("Partial"), { type: "response.incomplete", response: {
      output: [reasoningItem()], incomplete_details: { reason: "max_output_tokens" },
    } }];
    await expect(collectOpenAIResponsesStream(sse(events), enabled))
      .resolves.toEqual({ thinking: summary, text: "Partial", doneReason: "max_output_tokens" });
  });

  test("stops consuming summaries after terminal completion", () => {
    const normalizer = new OpenAIResponsesStreamNormalizer(enabled);
    normalizer.consume(completed());
    expect(normalizer.consume(delta("late"))).toEqual([]);
  });
});
