import { describe, expect, test } from "vitest";
import type { ModelGatewayEvent } from "../../types.js";
import { OpenAIResponsesStreamNormalizer } from "./stream-normalizer.js";
import { collectOpenAIResponsesStream, forwardOpenAIResponsesStream } from "./stream.js";
import {
  completedFunction, controlsFormat, functionArguments, functionCall, preamble, sse,
} from "./__tests__/native-function-fixture.js";

const options = { functionOutputName: controlsFormat.name };
const terminal = (output: unknown[], status = "completed") => ({ type: "response.completed", response: { status, output } });

test("arguments and commentary stay provisional until the completed response", () => {
  const normalizer = new OpenAIResponsesStreamNormalizer(options);
  for (const event of preamble) expect(normalizer.consume(event)).toEqual([]);
  expect(normalizer.hasTerminated).toBe(false);
  expect(normalizer.consume(completedFunction)).toEqual([
    { type: "content", text: functionArguments },
    { type: "done", done: true, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  ]);
  expect(normalizer.hasTerminated).toBe(true);
  expect(normalizer.consume(completedFunction)).toEqual([]);
  expect(normalizer.finish()).toEqual([]);
  expect(normalizer.end()).toEqual([]);
});

test("the terminal call snapshot supplies exact arguments, independent of message phases and delta aliases", async () => {
  const result = await collectOpenAIResponsesStream(sse([
    ...preamble,
    { type: "response.output_text.delta", delta: "irrelevant", item_id: "other" },
    terminal([{ type: "message", phase: "final_answer", content: [{ type: "output_text", text: "wrong" }] }, functionCall]),
  ]), options);
  expect(result).toEqual({ text: functionArguments, thinking: "" });
});

describe.each(["raw", "chat"] as const)("native function failures: %s", (endpoint) => {
  test.each([
    ["missing call", terminal([]), "exactly one call"],
    ["two calls", terminal([functionCall, { ...functionCall, call_id: "call_2" }]), "exactly one call"],
    ["wrong function", terminal([{ ...functionCall, name: "other" }]), "name mismatch"],
    ["in-progress response", terminal([functionCall], "in_progress"), "not completed"],
    ["in-progress call", terminal([{ ...functionCall, status: "in_progress" }]), "not completed"],
    ["missing identity", terminal([{ ...functionCall, call_id: "" }]), "identity invalid"],
    ["malformed JSON", terminal([{ ...functionCall, arguments: '{"decision":' }]), "arguments"],
    ["JSON scalar", terminal([{ ...functionCall, arguments: '"text"' }]), "arguments"],
    ["provider failure", { type: "response.failed", response: { error: { message: "provider failure" } } }, "provider failure"],
    ["provider error", { type: "error", error: { message: "transport failed" } }, "transport failed"],
    ["output limit", { type: "response.incomplete", response: { output: [functionCall], incomplete_details: { reason: "max_output_tokens" } } }, "max_output_tokens"],
    ["refusal", terminal([{ type: "message", content: [{ type: "refusal", refusal: "denied" }] }]), "exactly one call"],
    ["EOF", undefined, "not completed"],
    ["DONE sentinel", "[DONE]", "not completed"],
  ])("rejects %s without emitting provisional controls or success", async (_name, event, message) => {
    const events = [...preamble, ...(typeof event === "object" ? [event] : [])];
    const body = sse(events, event === "[DONE]" ? "data: [DONE]\n\n" : "");
    if (endpoint === "raw") {
      await expect(collectOpenAIResponsesStream(body, options)).rejects.toThrow(message);
      return;
    }
    const output: ModelGatewayEvent[] = [];
    await forwardOpenAIResponsesStream(body, { emit: (value) => output.push(value) }, options);
    expect(output).toEqual([{ type: "error", error: expect.stringContaining(message) }]);
  });
});

test("accepts a terminal function item without the optional status field", async () => {
  const { status: _status, ...call } = functionCall;
  await expect(collectOpenAIResponsesStream(sse([terminal([call])]), options))
    .resolves.toEqual({ text: functionArguments, thinking: "" });
});
