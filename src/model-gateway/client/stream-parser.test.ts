import { describe, expect, test, vi } from "vitest";

import { applyStreamLine } from "./stream-parser.js";

describe("applyStreamLine", () => {
  test("normalizes final text events as content", () => {
    const onStreamEvent = vi.fn();
    const onToken = vi.fn();
    const output = applyStreamLine(
      JSON.stringify({ type: "final", text: "done" }),
      { onStreamEvent, onToken },
      "",
    );

    expect(output).toBe("done");
    expect(onToken).toHaveBeenCalledWith("done");
    expect(onStreamEvent).toHaveBeenCalledWith({
      kind: "content",
      text: "done",
    });
  });

  test("normalizes done text events as content", () => {
    const onStreamEvent = vi.fn();
    const onToken = vi.fn();
    const output = applyStreamLine(
      JSON.stringify({ type: "done", data: { text: "done" } }),
      { onStreamEvent, onToken },
      "",
    );

    expect(output).toBe("done");
    expect(onToken).toHaveBeenCalledWith("done");
    expect(onStreamEvent).toHaveBeenCalledWith({
      kind: "content",
      text: "done",
    });
  });

  test("ignores bare done events without classifying them as unknown content", () => {
    const onStreamEvent = vi.fn();
    const output = applyStreamLine(
      JSON.stringify({ type: "done" }),
      { onStreamEvent },
      "partial",
    );

    expect(output).toBe("partial");
    expect(onStreamEvent).toHaveBeenCalledWith({
      kind: "content_empty",
    });
  });

  test("forwards normalized token usage from done events", () => {
    const onUsage = vi.fn();
    const output = applyStreamLine(
      JSON.stringify({
        type: "done",
        usage: {
          inputTokens: 120,
          cachedInputTokens: 80,
          outputTokens: 30,
          reasoningTokens: 10,
          totalTokens: 150,
        },
      }),
      { onUsage },
      "partial",
    );

    expect(output).toBe("partial");
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 30,
      reasoningTokens: 10,
      totalTokens: 150,
    });
  });

  test("forwards the bounded provider completion reason from done events", () => {
    const onTerminal = vi.fn();
    const output = applyStreamLine(
      JSON.stringify({
        type: "done",
        doneReason: "length",
      }),
      { onTerminal },
      "partial",
    );

    expect(output).toBe("partial");
    expect(onTerminal).toHaveBeenCalledWith({
      providerCompletionReason: "length",
    });
  });

  test("normalizes assistant stream deltas as content", () => {
    const onStreamEvent = vi.fn();
    const onToken = vi.fn();
    const output = applyStreamLine(
      JSON.stringify({
        stream: "assistant",
        data: { delta: '{"kind":"final","message":"done"}' },
      }),
      { onStreamEvent, onToken },
      "",
    );

    expect(output).toBe('{"kind":"final","message":"done"}');
    expect(onToken).toHaveBeenCalledWith('{"kind":"final","message":"done"}');
    expect(onStreamEvent).toHaveBeenCalledWith({
      kind: "content",
      text: '{"kind":"final","message":"done"}',
    });
  });

  test("emits content_empty when content token is empty", () => {
    const onStreamEvent = vi.fn();
    const output = applyStreamLine(
      JSON.stringify({ type: "content", text: "" }),
      { onStreamEvent },
      "",
    );

    expect(output).toBe("");
    expect(onStreamEvent).toHaveBeenCalledWith({
      kind: "content_empty",
    });
  });

  test("throws stream error events instead of treating them as content", () => {
    const onStreamEvent = vi.fn();

    expect(() =>
      applyStreamLine(
        JSON.stringify({ type: "error", error: "quota exceeded" }),
        { onStreamEvent },
        "partial",
      ),
    ).toThrow("model_stream_error: quota exceeded");
    expect(onStreamEvent).toHaveBeenCalledWith({
      kind: "error",
      text: "quota exceeded",
    });
  });
});
