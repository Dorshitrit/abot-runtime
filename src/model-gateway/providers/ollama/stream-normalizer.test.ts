import { describe, expect, test } from "vitest";

import {
  collectOllamaStream,
  writeGatewayEvents,
} from "./stream-normalizer.js";
import type { ModelProviderEventSink } from "../contracts.js";

function serializedEventSink(chunks: string[]): ModelProviderEventSink {
  return {
    emit(event) {
      chunks.push(`${JSON.stringify(event)}\n`);
    },
  };
}

function createNdjsonStream(lines: unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
        ),
      );
      controller.close();
    },
  });
}

describe("Ollama stream normalization", () => {
  test("forwards final provider token counts in the done event", () => {
    const chunks: string[] = [];

    writeGatewayEvents(serializedEventSink(chunks), {
      done: true,
      done_reason: "stop",
      prompt_eval_count: 120,
      eval_count: 30,
    });

    expect(chunks).toEqual([
      `${JSON.stringify({
        type: "done",
        done: true,
        doneReason: "stop",
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        },
      })}\n`,
    ]);
  });

  test("reports terminal provider timing without changing gateway events", () => {
    const chunks: string[] = [];
    const timings: unknown[] = [];

    writeGatewayEvents(
      serializedEventSink(chunks),
      {
        done: true,
        done_reason: "stop",
        load_duration: 10,
        prompt_eval_duration: 20,
        eval_duration: 30,
        total_duration: 70,
      },
      {
        onTerminalTiming(timing) {
          timings.push(timing);
        },
      },
    );

    expect(timings).toEqual([
      {
        loadDurationNs: 10,
        promptEvalDurationNs: 20,
        evalDurationNs: 30,
        totalDurationNs: 70,
      },
    ]);
    expect(chunks).toEqual([
      `${JSON.stringify({
        type: "done",
        done: true,
        doneReason: "stop",
      })}\n`,
    ]);
  });

  test("collects provider token counts with raw output", async () => {
    const collected = await collectOllamaStream(
      createNdjsonStream([
        { message: { content: "ok" }, done: false },
        {
          done: true,
          done_reason: "length",
          prompt_eval_count: 45,
          eval_count: 7,
        },
      ]),
    );

    expect(collected).toEqual({
      text: "ok",
      thinking: "",
      doneReason: "length",
      usage: {
        inputTokens: 45,
        outputTokens: 7,
        totalTokens: 52,
      },
    });
  });

  test("collects raw output while reporting terminal provider timing", async () => {
    const timings: unknown[] = [];
    const collected = await collectOllamaStream(
      createNdjsonStream([
        { message: { content: "ok" }, done: false },
        { done: true, total_duration: 99 },
      ]),
      {
        onTerminalTiming(timing) {
          timings.push(timing);
        },
      },
    );

    expect(collected).toEqual({
      text: "ok",
      thinking: "",
      doneReason: null,
    });
    expect(timings).toEqual([{ totalDurationNs: 99 }]);
  });

  test("projects passive normalized-event diagnostics without changing output", async () => {
    const observed: unknown[] = [];
    const collected = await collectOllamaStream(
      createNdjsonStream([
        { message: { thinking: "inspect", content: "ok" }, done: false },
        { done: true, done_reason: "stop" },
      ]),
      {
        onNormalizedEvent(event) {
          observed.push(event);
        },
      },
    );

    expect(collected).toEqual({
      text: "ok",
      thinking: "inspect",
      doneReason: "stop",
    });
    expect(observed).toEqual([
      { type: "thinking", text: "inspect" },
      { type: "content", text: "ok" },
      { type: "done", done: true, doneReason: "stop" },
    ]);
  });
});
