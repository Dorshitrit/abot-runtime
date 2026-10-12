import { describe, expect, test, vi } from "vitest";
import type { ModelGatewayEvent } from "../../types.js";
import {
  collectOllamaStream,
  forwardOllamaStream,
} from "./stream-normalizer.js";
import { OllamaStreamTerminationError } from "./stream-termination.js";

const PARTIAL = "Partial answer before provider failure.";
const PARTIAL_FRAME = JSON.stringify({
  model: "qa-mock",
  message: { role: "assistant", content: PARTIAL },
  done: false,
  prompt_eval_count: 10,
  eval_count: 6,
});
const ERROR_FRAME = JSON.stringify({
  error: "Synthetic midstream provider failure",
});

function byteStream(bytes: Uint8Array, split = bytes.length) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  });
}

describe.each(["forward", "collect"] as const)(
  "Ollama %s stream integrity",
  (mode) => {
    const consume = (
      body: ReadableStream<Uint8Array>,
      events: ModelGatewayEvent[] = [],
    ) =>
      mode === "forward"
        ? forwardOllamaStream(body, { emit: (event) => events.push(event) })
        : collectOllamaStream(body, {
            onNormalizedEvent: (event) => events.push(event),
          });

    test.each([
      [
        "newline error",
        `${PARTIAL_FRAME}\n${ERROR_FRAME}\n`,
        "ollama_stream_error: Synthetic midstream provider failure",
      ],
      [
        "unterminated error",
        `${PARTIAL_FRAME}\n${ERROR_FRAME}`,
        "ollama_stream_error: Synthetic midstream provider failure",
      ],
      ["newline EOF", `${PARTIAL_FRAME}\n`, "ollama_stream_missing_terminal"],
      ["unterminated EOF", PARTIAL_FRAME, "ollama_stream_missing_terminal"],
      [
        "malformed terminal",
        `${PARTIAL_FRAME}\n{`,
        "ollama_stream_missing_terminal",
      ],
    ])(
      "rejects %s without promoting partial output",
      async (_name, text, message) => {
        const bytes = new TextEncoder().encode(text);
        const events: ModelGatewayEvent[] = [];
        const body = byteStream(bytes, PARTIAL_FRAME.length + 5);

        await expect(consume(body, events)).rejects.toMatchObject({
          name: "OllamaStreamTerminationError",
          message,
        });
        expect(events).toEqual([{ type: "content", text: PARTIAL }]);
        expect(body.locked).toBe(false);
      },
    );

    test("provider error takes precedence over content and done in the same frame", async () => {
      const events: ModelGatewayEvent[] = [];
      const frame = JSON.stringify({
        message: { content: PARTIAL },
        done: true,
        done_reason: "stop",
        error: "Synthetic midstream provider failure",
      });
      await expect(
        consume(byteStream(new TextEncoder().encode(frame)), events),
      ).rejects.toBeInstanceOf(OllamaStreamTerminationError);
      expect(events).toEqual([]);
    });

    test.each(["stop", "length"])(
      "retains valid %s completion with split UTF-8 and trailing terminal",
      async (reason) => {
        const text = "שלום 🌍";
        const frame = JSON.stringify({
          message: { content: text },
          done: false,
        });
        const bytes = new TextEncoder().encode(
          `${frame}\n${JSON.stringify({
            done: true,
            done_reason: reason,
            prompt_eval_count: 10,
            eval_count: 6,
          })}`,
        );
        const firstMultibyte = bytes.findIndex((byte) => byte > 127);
        const body = byteStream(bytes, firstMultibyte + 1);
        const events: ModelGatewayEvent[] = [];
        const result = await consume(body, events);

        expect(events).toEqual([
          { type: "content", text },
          {
            type: "done",
            done: true,
            doneReason: reason,
            usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
          },
        ]);
        if (mode === "collect")
          expect(result).toMatchObject({ text, doneReason: reason });
        expect(body.locked).toBe(false);
      },
    );

    test("cancels and releases a provider that remains open after its error frame", async () => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`${PARTIAL_FRAME}\n${ERROR_FRAME}\n`),
          );
        },
        cancel,
      });
      await expect(consume(body)).rejects.toBeInstanceOf(
        OllamaStreamTerminationError,
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    });

    test.each(["AbortError", "TypeError"])(
      "preserves a reader %s instead of reporting missing terminal",
      async (name) => {
        const failure = Object.assign(new Error("original reader failure"), {
          name,
        });
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(failure);
          },
        });
        await expect(consume(body)).rejects.toBe(failure);
        expect(body.locked).toBe(false);
      },
    );
  },
);
