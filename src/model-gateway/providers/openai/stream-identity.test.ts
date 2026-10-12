import { describe, expect, test } from "vitest";
import { OpenAIResponsesStreamNormalizer } from "./stream-normalizer.js";
import { collectOpenAIResponsesStream, forwardOpenAIResponsesStream } from "./stream.js";

const answer = '{"action":"respond","text":"שלום"}';
const pieces = [answer.slice(0, 8), answer.slice(8, 19), answer.slice(19, 29), answer.slice(29)];

function delta(identity: Record<string, unknown>, text: string) {
  return { type: "response.output_text.delta", ...identity, delta: text };
}

function metadata(phase?: string, type = "response.output_item.done") {
  return { type, output_index: 0, item: { type: "message", id: "answer", phase } };
}

function completed() {
  return { type: "response.completed", response: {} };
}

function sse(events: unknown[]) {
  const bytes = new TextEncoder().encode(events.map((event) =>
    `data: ${JSON.stringify(event)}\n\n`,
  ).join(""));
  return new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes);
    controller.close();
  } });
}

async function expectTransportParity(events: unknown[], text: string) {
  const collectedDiagnostics: unknown[] = [];
  const forwardedDiagnostics: unknown[] = [];
  const collected = await collectOpenAIResponsesStream(sse(events), {
    structuredOutput: true, onMessageOutputDiagnostic: (value) => collectedDiagnostics.push(value),
  });
  const forwarded: { type: string; text?: string }[] = [];
  await forwardOpenAIResponsesStream(sse(events), { emit: (event) => forwarded.push(event) }, {
    structuredOutput: true, onMessageOutputDiagnostic: (value) => forwardedDiagnostics.push(value),
  });
  expect(collected.text).toBe(text);
  expect(forwarded.filter((event) => event.type === "content").map((event) => event.text).join("")).toBe(text);
  expect(forwardedDiagnostics).toEqual(collectedDiagnostics);
  return { collected, forwarded, diagnostics: collectedDiagnostics };
}

describe.each(["index-first", "id-first"])("OpenAI split message identity: %s", (order) => {
  const identities = order === "index-first"
    ? [{ output_index: 0 }, { item_id: "answer" }]
    : [{ item_id: "answer" }, { output_index: 0 }];
  const chunks = pieces.map((text, index) => delta(identities[index % 2], text));

  test.each(["final_answer", undefined])("merges interleaved chunks with phase %s", async (phase) => {
    for (const type of ["response.output_item.added", "response.output_item.done", "response.completed"]) {
      const bridge = type === "response.completed"
        ? { type, response: { output: [metadata(phase).item] } }
        : metadata(phase, type);
      const result = await expectTransportParity([...chunks, bridge, completed()], answer);
      expect(result.diagnostics).toEqual([]);
    }
  });

  test("binds both aliases when the joining event is a text delta", async () => {
    const bridge = delta({ item_id: "answer", output_index: 0 }, "!");
    const events = [...chunks, bridge, delta(identities[0], "A"), delta(identities[1], "B"), completed()];
    const result = await expectTransportParity(events, answer + "!AB");
    expect(result.diagnostics).toEqual([]);
  });

  test("retains legacy first-text selection and counts a merged message only once", async () => {
    const events = [
      { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "other" } },
      ...chunks,
      delta({ output_index: 1, item_id: "other" }, "ignore me"),
      metadata(), completed(),
    ];
    const result = await expectTransportParity(events, answer);
    expect(result.diagnostics).toMatchObject([{
      outputCount: 2, ignoredOutputCount: 1,
      selectedOutput: { itemId: "answer", outputIndex: 0, textByteCount: Buffer.byteLength(answer) },
      sampledIgnoredOutputs: [{ itemId: "other" }],
    }]);
  });

  test("discards every commentary alias while preserving a different final answer", async () => {
    const events = [...chunks, metadata("commentary"),
      { type: "response.output_item.added", output_index: 1,
        item: { type: "message", id: "final", phase: "final_answer" } },
      delta({ output_index: 1, item_id: "final" }, "actual final"), completed()];
    const result = await expectTransportParity(events, "actual final");
    expect(result.diagnostics).toMatchObject([{ outputCount: 2, ignoredOutputCount: 1,
      sampledIgnoredOutputs: [{ itemId: "answer", textByteCount: Buffer.byteLength(answer), phase: "commentary" }] }]);
  });

  test("preserves incomplete termination and usage after joining identities", async () => {
    const result = await expectTransportParity([...chunks, {
      type: "response.incomplete", response: {
        output: [metadata("final_answer").item], incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      },
    }], answer);
    expect(result.collected).toMatchObject({ doneReason: "max_output_tokens",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
    expect(result.forwarded.at(-1)).toMatchObject({ type: "done", doneReason: "max_output_tokens" });
  });

  test("does not release buffered aliases on provider failure", async () => {
    const events = [...chunks, metadata(), { type: "error", error: { message: "provider failure" } }];
    await expect(collectOpenAIResponsesStream(sse(events), { structuredOutput: true })).rejects.toThrow("provider failure");
    const forwarded: unknown[] = [];
    await forwardOpenAIResponsesStream(sse(events), { emit: (event) => forwarded.push(event) }, { structuredOutput: true });
    expect(forwarded).toEqual([{ type: "error", error: "provider failure" }]);
  });
});

test.each(["id", "index"])("waits for final metadata with only %s to bind the pending aliases", (identity) => {
  const normalizer = new OpenAIResponsesStreamNormalizer({ structuredOutput: true });
  expect(normalizer.consume(delta({ output_index: 0 }, pieces[0]))).toEqual([]);
  expect(normalizer.consume(delta({ item_id: "answer" }, pieces[1]))).toEqual([]);
  const partial = identity === "id"
    ? { type: "response.output_item.added", item: { type: "message", id: "answer", phase: "final_answer" } }
    : { type: "response.output_item.added", output_index: 0, item: { type: "message", phase: "final_answer" } };
  expect(normalizer.consume(partial)).toEqual([]);
  expect(normalizer.consume(delta({ item_id: "answer" }, pieces[2]))).toEqual([]);
  expect(normalizer.consume(delta({ output_index: 0 }, pieces[3]))).toEqual([]);
  expect(normalizer.consume(metadata())).toEqual(pieces.map((text) => ({ type: "content", text })));
  expect(normalizer.consume(delta({ item_id: "answer" }, "!"))).toEqual([{ type: "content", text: "!" }]);
  expect(normalizer.consume(completed())).toEqual([{ type: "done", done: true }]);
});

test("finishes a final message whose identity remains partial at response completion", async () => {
  await expectTransportParity([
    { type: "response.output_item.added", item: { type: "message", id: "answer", phase: "final_answer" } },
    delta({ item_id: "answer" }, answer), completed(),
  ], answer);
});
