import { afterEach, describe, expect, test, vi } from "vitest";

import {
  buildModelInvocationMetrics,
  classifyEmptyResponse,
  createModelGatewayClient,
  invokeModelGateway,
} from "../client.js";

function createStream(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${lines.join("\n")}\n`));
      controller.close();
    },
  });
}

function createChunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.LLM_RUNTIME_STREAM_INACTIVITY_TIMEOUT_MS;
});

describe("classifyEmptyResponse", () => {
  test("classifies thinking-only responses", () => {
    expect(
      classifyEmptyResponse({
        status: 200,
        chunkCount: 10,
        totalBytes: 500,
        thinkingEvents: 8,
        contentEvents: 0,
        contentEmptyEvents: 0,
        invalidJsonLines: 0,
        unknownTypeCounts: {},
        outputLength: 0,
      }),
    ).toBe("thinking_only_response");
  });

  test("classifies parser or assembly failures", () => {
    expect(
      classifyEmptyResponse({
        status: 200,
        chunkCount: 4,
        totalBytes: 300,
        thinkingEvents: 0,
        contentEvents: 0,
        contentEmptyEvents: 0,
        invalidJsonLines: 3,
        unknownTypeCounts: {},
        outputLength: 0,
      }),
    ).toBe("parser_or_stream_assembly_failure");
  });

  test("classifies unknown event shape responses", () => {
    expect(
      classifyEmptyResponse({
        status: 200,
        chunkCount: 5,
        totalBytes: 350,
        thinkingEvents: 0,
        contentEvents: 0,
        contentEmptyEvents: 0,
        invalidJsonLines: 0,
        unknownTypeCounts: { final: 5 },
        outputLength: 0,
      }),
    ).toBe("unrecognized_stream_event_shape");
  });
});

describe("buildModelInvocationMetrics", () => {
  test("counts request text once when it is already present in messages", () => {
    const metrics = buildModelInvocationMetrics({
      text: "repeat",
      messages: [{ role: "user", content: "repeat" }],
      outputText: "ok",
      durationMs: 1,
      status: "success",
    });

    expect(metrics).toMatchObject({
      textChars: 6,
      messagesChars: 6,
      inputCharsSource: "messages",
      totalInputChars: 6,
      estimatedInputTokens: 2,
      tokenUsageSource: "estimated",
      inputTokens: 2,
    });
  });

  test("uses provider usage while retaining fallback estimates for diagnostics", () => {
    const metrics = buildModelInvocationMetrics({
      text: "repeat",
      messages: [{ role: "user", content: "repeat" }],
      outputText: "ok",
      providerUsage: {
        inputTokens: 120,
        cachedInputTokens: 80,
        outputTokens: 30,
        reasoningTokens: 10,
        totalTokens: 150,
      },
      durationMs: 1,
      status: "success",
    });

    expect(metrics).toMatchObject({
      estimatedInputTokens: 2,
      tokenUsageSource: "provider",
      inputTokens: 120,
      cachedInputTokens: 80,
      uncachedInputTokens: 40,
      outputTokens: 30,
      reasoningTokens: 10,
      totalTokens: 150,
    });
  });
});

describe("input token count client", () => {
  test("does not contact the gateway for an unsupported provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createModelGatewayClient({
      baseUrl: "http://configured-gateway.test/",
    });

    const result = await client.countInputTokens({
      provider: "ollama",
      messages: [{ role: "user", content: "Do not count this remotely." }],
      agentMode: "reasoning",
      modelStep: "supervisor.response",
      abortSignal: new AbortController().signal,
    });

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("counts OpenAI input once and caches an identical request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        inputTokens: 321,
        profileId: "luna",
        provider: "openai",
        model: "gpt-test-luna",
        contextWindowTokens: 128_000,
        source: "provider_input_token_count",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createModelGatewayClient({
      baseUrl: "http://configured-gateway.test/",
    });
    const params = {
      provider: "openai",
      messages: [{ role: "user" as const, content: "Count this input." }],
      agentMode: "reasoning" as const,
      modelStep: "supervisor.response" as const,
      abortSignal: new AbortController().signal,
    };

    const first = await client.countInputTokens(params);
    const second = await client.countInputTokens(params);

    expect(first).toEqual(second);
    expect(first?.inputTokens).toBe(321);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://configured-gateway.test/input-tokens",
    );
  });
});

describe("invokeModelGateway", () => {
  test("created client uses configured gateway URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      body: createStream([
        JSON.stringify({
          type: "done",
          data: { text: "ok" },
        }),
      ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createModelGatewayClient({
      baseUrl: "http://configured-gateway.test/",
    });
    await client.invoke({
      text: "continue",
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://configured-gateway.test/chat",
    );
  });

  test("created raw client uses configured gateway URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        text: "ok",
        thinking: "",
        usage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
        },
        providerCompletionReason: "max_output_tokens",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createModelGatewayClient({
      baseUrl: "http://configured-gateway.test/",
    });
    const format = {
      type: "object",
      properties: { operations: { type: "array" } },
    };
    const response = await client.invokeRaw({
      prompt: "continue",
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
      format,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://configured-gateway.test/raw",
    );
    expect(
      JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).format,
    ).toEqual(format);
    expect(response.meta.usage).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
    });
    expect(response.meta.providerCompletionReason).toBe("max_output_tokens");
  });

  test("captures assistant stream output that would otherwise be an unknown event shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      body: createStream([
        JSON.stringify({
          stream: "thinking",
          data: { delta: "checking result" },
        }),
        JSON.stringify({
          stream: "assistant",
          data: {
            delta: '{"kind":"final","message":"Search complete."}',
            text: '{"kind":"final","message":"Search complete."}',
          },
        }),
      ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await invokeModelGateway({
      text: "continue",
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
    });

    expect(response.text).toBe('{"kind":"final","message":"Search complete."}');
    expect(response.meta.thinkingEvents).toBe(1);
    expect(response.meta.contentEvents).toBe(1);
    expect(response.meta.unknownTypeCounts).toEqual({});
    expect(response.meta.emptyReason).toBeUndefined();
  });

  test("captures done-event output emitted in data.text", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      body: createStream([
        JSON.stringify({
          type: "done",
          doneReason: "length",
          data: { text: '{"kind":"final","message":"Search complete."}' },
          usage: {
            inputTokens: 40,
            cachedInputTokens: 16,
            outputTokens: 8,
            totalTokens: 48,
          },
        }),
      ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await invokeModelGateway({
      text: "continue",
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
    });

    expect(response.text).toBe('{"kind":"final","message":"Search complete."}');
    expect(response.meta.contentEvents).toBe(1);
    expect(response.meta.unknownTypeCounts).toEqual({});
    expect(response.meta.emptyReason).toBeUndefined();
    expect(response.meta.terminalEventCount).toBe(1);
    expect(response.meta.providerCompletionReason).toBe("length");
    expect(response.meta.usage).toEqual({
      inputTokens: 40,
      cachedInputTokens: 16,
      outputTokens: 8,
      totalTokens: 48,
    });
  });

  test("assembles split and unterminated stream lines without reordering callbacks", async () => {
    const firstChunk = '{"type":"content","text":"hel';
    const secondChunk =
      'lo"}\n' +
      JSON.stringify({
        type: "done",
        doneReason: "length",
        data: { text: "!" },
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
        },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        body: createChunkedStream([firstChunk, secondChunk]),
      }),
    );
    const callbackOrder: string[] = [];

    const response = await invokeModelGateway({
      text: "continue",
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
      onToken: (text) => callbackOrder.push(`token:${text}`),
      onUsage: () => callbackOrder.push("usage"),
      onTerminal: ({ providerCompletionReason }) =>
        callbackOrder.push(`terminal:${providerCompletionReason}`),
    });

    expect(response).toEqual({
      text: "hello!",
      meta: {
        status: 200,
        chunkCount: 2,
        totalBytes:
          new TextEncoder().encode(firstChunk).byteLength +
          new TextEncoder().encode(secondChunk).byteLength,
        thinkingEvents: 0,
        contentEvents: 2,
        contentEmptyEvents: 0,
        invalidJsonLines: 0,
        unknownTypeCounts: {},
        outputLength: 6,
        terminalEventCount: 1,
        providerCompletionReason: "length",
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          totalTokens: 15,
        },
      },
    });
    expect(callbackOrder).toEqual([
      "token:hello",
      "usage",
      "terminal:length",
      "token:!",
    ]);
  });

  test("keeps the latest non-null provider completion reason", async () => {
    const terminalReasons: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        body: createStream([
          JSON.stringify({ type: "done", data: { text: "a" } }),
          JSON.stringify({
            type: "done",
            doneReason: "length",
            data: { text: "b" },
          }),
          JSON.stringify({ type: "done", data: { text: "c" } }),
        ]),
      }),
    );

    const response = await invokeModelGateway({
      text: "continue",
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
      onTerminal: ({ providerCompletionReason }) =>
        terminalReasons.push(providerCompletionReason),
    });

    expect(terminalReasons).toEqual([null, "length", null]);
    expect(response.meta.terminalEventCount).toBe(3);
    expect(response.meta.providerCompletionReason).toBe("length");
  });

  test("aborts active stream consumption when the request signal aborts", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    let markReadStarted: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const read = vi.fn(() => {
      markReadStarted();
      return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
    });
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      body: {
        getReader: () => ({
          read,
          cancel,
        }),
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const abortController = new AbortController();
    const responsePromise = invokeModelGateway({
      text: "inspect file",
      agentMode: "reasoning",
      abortSignal: abortController.signal,
    });

    await readStarted;
    abortController.abort("stop");

    await expect(responsePromise).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: abortController.signal,
      }),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("aborts stalled streams with a bounded inactivity timeout", async () => {
    vi.useFakeTimers();
    process.env.LLM_RUNTIME_STREAM_INACTIVITY_TIMEOUT_MS = "25";
    const cancel = vi.fn().mockResolvedValue(undefined);
    let markReadStarted: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const read = vi.fn(() => {
      markReadStarted();
      return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        body: {
          getReader: () => ({
            read,
            cancel,
          }),
        },
      }),
    );

    const responsePromise = invokeModelGateway({
      text: "continue",
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
    });
    const rejectionExpectation = expect(responsePromise).rejects.toMatchObject({
      name: "AbortError",
      message: "llm_stream_inactivity_timeout",
    });

    await readStarted;
    await vi.advanceTimersByTimeAsync(25);

    await rejectionExpectation;
    expect(cancel).toHaveBeenCalledWith("llm_stream_inactivity_timeout");
  });

  test("resolves the inactivity deadline again for every stream read", async () => {
    vi.useFakeTimers();
    process.env.LLM_RUNTIME_STREAM_INACTIVITY_TIMEOUT_MS = "1000";
    const cancel = vi.fn().mockResolvedValue(undefined);
    let markSecondReadStarted: () => void = () => {};
    const secondReadStarted = new Promise<void>((resolve) => {
      markSecondReadStarted = resolve;
    });
    const firstValue = new TextEncoder().encode(
      `${JSON.stringify({ type: "content", text: "partial" })}\n`,
    );
    const read = vi
      .fn()
      .mockImplementationOnce(async () => {
        process.env.LLM_RUNTIME_STREAM_INACTIVITY_TIMEOUT_MS = "25";
        return { done: false, value: firstValue };
      })
      .mockImplementationOnce(() => {
        markSecondReadStarted();
        return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
      });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        body: { getReader: () => ({ read, cancel }) },
      }),
    );

    const responsePromise = invokeModelGateway({
      text: "continue",
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
    });
    const rejectionExpectation = expect(responsePromise).rejects.toMatchObject({
      name: "AbortError",
      message: "llm_stream_inactivity_timeout",
    });

    await secondReadStarted;
    await vi.advanceTimersByTimeAsync(25);

    await rejectionExpectation;
    expect(read).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledWith("llm_stream_inactivity_timeout");
  });

  test("disposes the abort listener and deadline after a completed read", async () => {
    vi.useFakeTimers();
    process.env.LLM_RUNTIME_STREAM_INACTIVITY_TIMEOUT_MS = "25";
    const cancel = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockResolvedValue({ done: true, value: undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        body: { getReader: () => ({ read, cancel }) },
      }),
    );
    const abortController = new AbortController();

    await invokeModelGateway({
      text: "continue",
      agentMode: "reasoning",
      abortSignal: abortController.signal,
    });
    abortController.abort("late abort");
    await vi.advanceTimersByTimeAsync(25);

    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  test("sanitizes message metadata before sending the chat payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      body: createStream([
        JSON.stringify({
          type: "done",
          data: { text: '{"kind":"final","message":"ok"}' },
        }),
      ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await invokeModelGateway({
      messages: [
        {
          role: "system",
          content: "Development worker scope:\nAssigned task:\nImplement it",
          systemMessageKind: "development_worker_scope",
          workerScopeState: {
            task: "Implement it",
            acceptanceCriteria: ["It works"],
          },
        },
      ],
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
    });

    const fetchBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(fetchBody.messages).toEqual([
      {
        role: "system",
        content: "Development worker scope:\nAssigned task:\nImplement it",
      },
    ]);
  });

  test("forwards client model preference in the chat payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      body: createStream([
        JSON.stringify({
          type: "done",
          data: { text: "ok" },
        }),
      ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await invokeModelGateway({
      text: "continue",
      agentMode: "reasoning",
      modelPreference: {
        profileId: "qwen3.5-4b",
      },
      abortSignal: new AbortController().signal,
    });

    const fetchBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(fetchBody.modelPreference).toEqual({
      profileId: "qwen3.5-4b",
    });
  });

  test("configured client forwards runtime model policy in chat and raw payloads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        body: createStream([
          JSON.stringify({
            type: "done",
            data: { text: "ok" },
          }),
        ]),
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          text: "raw ok",
          thinking: "",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = createModelGatewayClient({
      modelPolicy: {
        profiles: {
          "local-chat": {
            model: "local-chat:model",
            contextWindowTokens: 32_768,
          },
        },
        defaults: {
          profileId: "local-chat",
        },
      },
    });

    await client.invoke({
      text: "continue",
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
    });
    await client.invokeRaw({
      prompt: "payload",
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
    });

    const chatBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    const rawBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(rawBody.modelStep).toBe("tool_payload.raw");
    expect(chatBody.modelPolicy).toEqual({
      profiles: {
        "local-chat": {
          model: "local-chat:model",
          contextWindowTokens: 32_768,
        },
      },
      defaults: {
        profileId: "local-chat",
      },
    });
    expect(rawBody.modelPolicy).toEqual(chatBody.modelPolicy);
  });
});
