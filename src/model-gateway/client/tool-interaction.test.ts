import { afterEach, describe, expect, test, vi } from "vitest";

import type { ChatMessage, ModelGatewayRequest } from "../types.js";
import {
  hasModelGatewayToolInteractionLane,
  validateModelGatewayMessages,
} from "../message-contract.js";
import {
  buildModelInvocationMetrics,
  invokeModelGateway,
  projectModelGatewayMetricMessages,
} from "../client.js";
import { buildOllamaPayload } from "../providers/ollama.js";
import { buildOpenAIResponsesPayload } from "../providers/openai.js";
import {
  createChatHandler,
  createRawHandler,
  type GatewayResponse,
} from "../server.js";

const TOOL_NAME = "runtime_capability";
const FIRST_ARGUMENTS =
  '{"kind":"action","note":"quote: \\"exact\\"\\r\\nשלום","invocation":{"executionId":"execution-1"}}';
const SECOND_ARGUMENTS =
  '{"kind":"action","invocation":{"executionId":"execution-2","path":"C:\\\\tmp\\\\file.txt"}}';
const FIRST_OUTPUT =
  '{"kind":"result","result":{"executionId":"execution-1","ok":true,"text":"line 1\\r\\nline 2 – שלום"}}';
const SECOND_FAILURE_OUTPUT =
  '{"kind":"result","result":{"executionId":"execution-2","ok":false,"error":"failed: \\"exact\\""}}';

function toolLane(callCount: 1 | 2 = 2): ChatMessage[] {
  const calls = [
    {
      callId: "execution-1",
      name: TOOL_NAME,
      arguments: FIRST_ARGUMENTS,
    },
    {
      callId: "execution-2",
      name: TOOL_NAME,
      arguments: SECOND_ARGUMENTS,
    },
  ].slice(0, callCount);
  const results: ChatMessage[] = [
    {
      role: "tool",
      content: FIRST_OUTPUT,
      toolCallId: "execution-1",
      toolName: TOOL_NAME,
    },
    {
      role: "tool",
      content: SECOND_FAILURE_OUTPUT,
      toolCallId: "execution-2",
      toolName: TOOL_NAME,
    },
  ].slice(0, callCount) as ChatMessage[];
  return [
    { role: "user", content: "Complete the unchanged request." },
    { role: "assistant", content: "", toolCalls: calls },
    ...results,
  ];
}

function providerRequest(
  provider: "ollama" | "openai",
  messages: unknown,
): ModelGatewayRequest {
  return {
    modelStep: "supervisor.decision",
    messages,
    modelPolicy: {
      providers: {
        [provider]: { type: provider },
      },
      profiles: {
        selected: {
          provider,
          model: `${provider}-model`,
          contextWindowTokens: 32_768,
        },
      },
      defaults: {
        profileId: "selected",
        steps: { "supervisor.decision": "supervisor.decision" },
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function captureResponse(): GatewayResponse & { body: string } {
  return {
    body: "",
    setHeader: vi.fn(),
    write(chunk: string): void {
      this.body += chunk;
    },
    end(chunk = ""): void {
      this.body += chunk;
    },
  };
}

function streamDone(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `${JSON.stringify({ type: "done", data: { text: "ok" } })}\n`,
        ),
      );
      controller.close();
    },
  });
}

describe("model gateway native tool interaction contract", () => {
  test.each([1, 2] as const)(
    "projects a linked %i-call interaction with provider parity",
    (callCount) => {
      const messages = toolLane(callCount);
      const original = structuredClone(messages);

      const ollama = buildOllamaPayload(providerRequest("ollama", messages));
      const openai = buildOpenAIResponsesPayload(
        providerRequest("openai", messages),
      );

      const expectedCalls = messages[1]!.toolCalls!;
      const expectedResults = messages.slice(2);
      expect(ollama.messages).toEqual([
        messages[0],
        {
          role: "assistant",
          tool_calls: expectedCalls.map((call, index) => ({
            type: "function",
            function: {
              index,
              name: call.name,
              arguments: JSON.parse(call.arguments),
            },
          })),
        },
        ...expectedResults.map((result) => ({
          role: "tool",
          tool_name: result.role === "tool" ? result.toolName : "",
          content: result.content,
        })),
      ]);
      expect(openai.input).toEqual([
        messages[0],
        ...expectedCalls.map((call) => ({
          type: "function_call",
          call_id: call.callId,
          name: call.name,
          arguments: call.arguments,
        })),
        ...expectedResults.map((result) => ({
          type: "function_call_output",
          call_id: result.role === "tool" ? result.toolCallId : "",
          output: result.content,
        })),
      ]);
      const openAIItems = openai.input as Array<Record<string, unknown>>;
      expect(openAIItems[1]?.arguments).toBe(FIRST_ARGUMENTS);
      expect(openAIItems.at(-1)?.output).toBe(
        callCount === 1 ? FIRST_OUTPUT : SECOND_FAILURE_OUTPUT,
      );
      expect(messages).toEqual(original);
    },
  );

  test("preserves an Ollama image message adjacent to a tool interaction", () => {
    const messages = toolLane(1);
    messages[0] = {
      role: "user",
      content: "Inspect this image, then continue.",
      attachments: [
        {
          id: "attachment-1",
          kind: "image",
          mimeType: "image/png",
          storageRef: "request/image.png",
          data: "aW1hZ2U=",
        },
      ],
    };

    const payload = buildOllamaPayload(providerRequest("ollama", messages));

    expect((payload.messages as unknown[])[0]).toEqual({
      role: "user",
      content: "Inspect this image, then continue.",
      images: ["aW1hZ2U="],
    });
    expect((payload.messages as unknown[])[1]).toHaveProperty("tool_calls");
  });

  test("preserves surrounding text context around a batch continuation", () => {
    const continuation = toolLane(2).slice(1);
    const messages: ChatMessage[] = [
      { role: "system", content: "Runtime contract." },
      { role: "user", content: "Bounded reference context." },
      { role: "user", content: "Available capability context." },
      { role: "user", content: "Earlier user request." },
      { role: "assistant", content: "Earlier assistant response." },
      { role: "user", content: "Complete the current request." },
      ...continuation,
      { role: "user", content: "Steering: keep the exact target." },
    ];
    const original = structuredClone(messages);

    expect(() => validateModelGatewayMessages(messages)).not.toThrow();
    const ollama = buildOllamaPayload(providerRequest("ollama", messages))
      .messages as unknown[];
    const openai = buildOpenAIResponsesPayload(
      providerRequest("openai", messages),
    ).input as unknown[];

    expect(ollama.slice(0, 6)).toEqual(messages.slice(0, 6));
    expect(ollama.at(-1)).toEqual(messages.at(-1));
    expect(openai.slice(0, 6)).toEqual(messages.slice(0, 6));
    expect(openai.at(-1)).toEqual(messages.at(-1));
    expect(
      openai.slice(6, -1).map((item) => (item as { type?: string }).type),
    ).toEqual([
      "function_call",
      "function_call",
      "function_call_output",
      "function_call_output",
    ]);
    expect(messages).toEqual(original);
  });

  test("charges exact call arguments, result linkage, and outputs in client metrics", () => {
    const messages = toolLane(2).slice(1);
    const metricMessages = projectModelGatewayMetricMessages(messages);
    const expectedContents = [
      [
        "execution-1",
        TOOL_NAME,
        FIRST_ARGUMENTS,
        "execution-2",
        TOOL_NAME,
        SECOND_ARGUMENTS,
      ].join("\n"),
      ["execution-1", TOOL_NAME, FIRST_OUTPUT].join("\n"),
      ["execution-2", TOOL_NAME, SECOND_FAILURE_OUTPUT].join("\n"),
    ];

    expect(metricMessages.map((message) => message.content)).toEqual(
      expectedContents,
    );
    const metrics = buildModelInvocationMetrics({
      messages: metricMessages,
      durationMs: 1,
      status: "success",
    });
    expect(metrics).toMatchObject({
      messageCount: 3,
      toolCallCount: 2,
      toolResultCount: 2,
      messagesChars: expectedContents.reduce(
        (total, content) => total + content.length,
        0,
      ),
    });
  });

  test.each([
    {
      label: "orphan result",
      messages: [toolLane(1)[2]],
      error: "model_gateway_tool_result_unmatched",
    },
    {
      label: "missing result",
      messages: toolLane(1).slice(0, 2),
      error: "model_gateway_tool_result_missing",
    },
    {
      label: "interleaved text",
      messages: [
        toolLane(1)[0],
        toolLane(1)[1],
        { role: "user", content: "interrupt" },
        toolLane(1)[2],
      ],
      error: "model_gateway_tool_result_order_invalid",
    },
    {
      label: "reversed batch results",
      messages: [
        toolLane(2)[0],
        toolLane(2)[1],
        toolLane(2)[3],
        toolLane(2)[2],
      ],
      error: "model_gateway_tool_result_order_invalid",
    },
    {
      label: "mismatched tool name",
      messages: [
        toolLane(1)[0],
        toolLane(1)[1],
        { ...toolLane(1)[2], toolName: "different_tool" },
      ],
      error: "model_gateway_tool_result_name_mismatch",
    },
    {
      label: "duplicate call id",
      messages: [
        toolLane(2)[0],
        {
          role: "assistant",
          content: "",
          toolCalls: [
            toolLane(2)[1]!.toolCalls![0],
            { ...toolLane(2)[1]!.toolCalls![1], callId: "execution-1" },
          ],
        },
        toolLane(2)[2],
        { ...toolLane(2)[3], toolCallId: "execution-1" },
      ],
      error: "model_gateway_tool_call_id_duplicate",
    },
    {
      label: "non-object arguments",
      messages: [
        toolLane(1)[0],
        {
          role: "assistant",
          content: "",
          toolCalls: [{ ...toolLane(1)[1]!.toolCalls![0], arguments: "[]" }],
        },
        toolLane(1)[2],
      ],
      error: "model_gateway_tool_interaction_invalid",
    },
    {
      label: "unknown field in strict lane",
      messages: [
        { role: "user", content: "request", untrusted: true },
        toolLane(1)[1],
        toolLane(1)[2],
      ],
      error: "model_gateway_tool_interaction_invalid",
    },
    {
      label: "attachments on a tool item",
      messages: [
        toolLane(1)[0],
        { ...toolLane(1)[1], attachments: [] },
        toolLane(1)[2],
      ],
      error: "model_gateway_tool_interaction_invalid",
    },
  ])(
    "rejects $label atomically at both provider boundaries",
    ({ messages, error }) => {
      expect(hasModelGatewayToolInteractionLane(messages)).toBe(true);
      expect(() => validateModelGatewayMessages(messages)).toThrow(error);
      expect(() =>
        buildOllamaPayload(providerRequest("ollama", messages)),
      ).toThrow(error);
      expect(() =>
        buildOpenAIResponsesPayload(providerRequest("openai", messages)),
      ).toThrow(error);
    },
  );

  test("keeps legacy text-only filtering when no tool marker is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      body: streamDone(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await invokeModelGateway({
      messages: [
        null,
        {
          role: "user",
          content: "legacy request",
          legacyMetadata: { ignored: true },
        },
      ],
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.messages).toEqual([
      { role: "user", content: "legacy request" },
    ]);
  });

  test("client forwards a valid lane exactly and rejects invalid lanes before fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      body: streamDone(),
    });
    vi.stubGlobal("fetch", fetchMock);
    const messages = toolLane(2);

    await invokeModelGateway({
      messages,
      agentMode: "reasoning",
      abortSignal: new AbortController().signal,
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.messages).toEqual(messages);

    fetchMock.mockClear();
    await expect(
      invokeModelGateway({
        messages: toolLane(1).slice(0, 2),
        agentMode: "reasoning",
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("model_gateway_tool_result_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("direct chat and raw handlers reject invalid or unsupported lanes before provider fetch", async () => {
    const fetchMock = vi.fn();
    const chat = createChatHandler({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const raw = createRawHandler({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const chatResponse = captureResponse();
    const rawResponse = captureResponse();

    await chat(
      { messages: toolLane(1).slice(0, 2), agentMode: "reasoning" },
      chatResponse,
    );
    await raw({ messages: toolLane(1), agentMode: "reasoning" }, rawResponse);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(chatResponse.statusCode).toBe(400);
    expect(chatResponse.body).toBe("model_gateway_tool_result_missing");
    expect(rawResponse.statusCode).toBe(400);
    expect(rawResponse.body).toBe(
      "model_gateway_raw_tool_interaction_not_supported",
    );
  });

  test.each([
    { role: "tool", content: "{}", toolCallId: "orphan", toolName: TOOL_NAME },
    { role: "assistant", content: "", toolCalls: [] },
  ])(
    "rejects a non-array tool marker before direct chat or raw provider access",
    async (messages) => {
      const fetchMock = vi.fn();
      const chat = createChatHandler({
        fetchImpl: fetchMock as unknown as typeof fetch,
      });
      const raw = createRawHandler({
        fetchImpl: fetchMock as unknown as typeof fetch,
      });
      const chatResponse = captureResponse();
      const rawResponse = captureResponse();

      await chat({ messages, agentMode: "reasoning" }, chatResponse);
      await raw({ messages, agentMode: "reasoning" }, rawResponse);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(chatResponse.statusCode).toBe(400);
      expect(chatResponse.body).toBe("model_gateway_tool_interaction_invalid");
      expect(rawResponse.statusCode).toBe(400);
      expect(rawResponse.body).toBe("model_gateway_tool_interaction_invalid");
    },
  );
});
