import { afterEach, expect, test, vi } from "vitest";
import type { GatewayResponse } from "./contracts.js";
import { writeChatStreamResponse } from "./chat-stream-response.js";

function captureResponse() {
  const chunks: string[] = [];
  const response: GatewayResponse = {
    setHeader: vi.fn(() => {
      if (chunks.length) throw new Error("headers already committed");
    }),
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
    }),
    end: vi.fn((chunk?: string) => {
      if (chunk) chunks.push(chunk);
    }),
  };
  return { response, chunks };
}

afterEach(() => vi.restoreAllMocks());

test("a stream failure after content ends with one generic error and no done", async () => {
  const { response, chunks } = captureResponse();
  const failure = new Error("private provider failure detail");
  vi.spyOn(console, "error").mockImplementation(() => {});
  await writeChatStreamResponse({
    response,
    abortSignal: new AbortController().signal,
    invocation: {
      kind: "chat",
      async stream(sink) {
        sink.emit({ type: "content", text: "partial" });
        throw failure;
      },
    },
  });
  expect(chunks.map((chunk) => JSON.parse(chunk))).toEqual([
    { type: "content", text: "partial" },
    { type: "error", error: "server error" },
  ]);
  expect(response.setHeader).toHaveBeenCalledTimes(2);
  expect(response.end).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledWith(failure);
});

test.each([400, 500])(
  "a failure before any event preserves its status %i error",
  async (statusCode) => {
    const { response, chunks } = captureResponse();
    const failure = Object.assign(new Error("original failure"), {
      statusCode,
    });
    await expect(
      writeChatStreamResponse({
        response,
        abortSignal: new AbortController().signal,
        invocation: {
          kind: "chat",
          async stream() {
            throw failure;
          },
        },
      }),
    ).rejects.toBe(failure);
    expect(chunks).toEqual([]);
    expect(response.end).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  "client cancellation stays silent after content=%s",
  async (emitContent) => {
    const { response, chunks } = captureResponse();
    const abort = new AbortController();
    const failure = new Error("client disconnected");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await writeChatStreamResponse({
      response,
      abortSignal: abort.signal,
      invocation: {
        kind: "chat",
        async stream(sink) {
          if (emitContent) sink.emit({ type: "content", text: "partial" });
          abort.abort(failure);
          throw failure;
        },
      },
    });
    expect(chunks.map((chunk) => JSON.parse(chunk))).toEqual(
      emitContent ? [{ type: "content", text: "partial" }] : [],
    );
    expect(response.end).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  },
);

test("normal completion preserves provider events and ends once", async () => {
  const { response, chunks } = captureResponse();
  await writeChatStreamResponse({
    response,
    abortSignal: new AbortController().signal,
    invocation: {
      kind: "chat",
      async stream(sink) {
        sink.emit({ type: "content", text: "complete" });
        sink.emit({ type: "done", done: true, doneReason: "stop" });
      },
    },
  });
  expect(chunks.map((chunk) => JSON.parse(chunk))).toEqual([
    { type: "content", text: "complete" },
    { type: "done", done: true, doneReason: "stop" },
  ]);
  expect(response.end).toHaveBeenCalledOnce();
});
