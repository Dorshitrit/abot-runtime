import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createChatHandler } from "../../server/chat-handler.js";
import type { GatewayResponse } from "../../server/contracts.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import { createOllamaProviderAdapter } from "./adapter.js";
import type { ModelGatewayEvent, ModelGatewayRequest } from "../../types.js";
import { traceDebug } from "../../../runtime/observability/debug-logger.js";

vi.mock("../../../runtime/observability/debug-logger.js", () => ({
  traceDebug: vi.fn(),
}));
vi.mock("../../observability/trace-store.js", () => ({
  isModelIoTraceEnabled: () => false,
  traceModelIo: vi.fn(async () => {}),
}));

const PARTIAL = "Partial answer before provider failure.";
const PARTIAL_FRAME = JSON.stringify({
  model: "qa-mock",
  message: { role: "assistant", content: PARTIAL },
  done: false,
  prompt_eval_count: 10,
  eval_count: 6,
});
const POLICY = {
  providers: { local: { type: "ollama" } },
  profiles: {
    fixture: {
      provider: "local",
      model: "qa-mock",
      contextWindowTokens: 32768,
    },
  },
  defaults: { profileId: "fixture" },
} as const;
const VARIANTS = [
  {
    name: "provider error",
    suffix: '\n{"error":"Synthetic midstream provider failure"}',
    error: "ollama_stream_error: Synthetic midstream provider failure",
  },
  {
    name: "premature EOF",
    suffix: "",
    error: "ollama_stream_missing_terminal",
  },
] as const;

function captureResponse(): GatewayResponse & {
  chunks: string[];
  ended: number;
} {
  const chunks: string[] = [];
  return {
    chunks,
    ended: 0,
    setHeader() {
      if (chunks.length)
        throw new Error("cannot reset committed response headers");
    },
    write(chunk) {
      chunks.push(chunk);
    },
    end(chunk) {
      if (chunk) chunks.push(chunk);
      this.ended += 1;
    },
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("Ollama adapter stream failure propagation", () => {
  test.each(VARIANTS)(
    "maps $name into one normalized error after partial content",
    async (variant) => {
      const handler = createChatHandler({
        modelPolicy: POLICY,
        fetchImpl: async () => new Response(PARTIAL_FRAME + variant.suffix),
      });
      const response = captureResponse();
      await handler(
        { text: "Synthetic QA", modelStep: "supervisor.response" },
        response,
      );

      expect(response.chunks.map((chunk) => JSON.parse(chunk))).toEqual([
        { type: "content", text: PARTIAL },
        { type: "error", error: variant.error },
      ]);
      expect(response.statusCode).toBeUndefined();
      expect(response.ended).toBe(1);
      expect(vi.mocked(traceDebug)).toHaveBeenCalledWith(
        "model-gateway.server",
        "ollama.stream.terminated",
        expect.objectContaining({
          outcome: "failed",
          abortRequested: false,
          error: {
            name: "OllamaStreamTerminationError",
            message: variant.error,
          },
        }),
      );
    },
  );

  test.each(VARIANTS)(
    "raw $name rejects instead of returning partial text",
    async (variant) => {
      const requestBody = { prompt: "Synthetic QA", modelPolicy: POLICY };
      await expect(
        createOllamaProviderAdapter({
          fallbackUrl: "http://unused.test",
        }).invoke({
          endpoint: "raw",
          requestBody,
          invocation: resolveModelInvocation(requestBody),
          fetchImpl: async () => new Response(PARTIAL_FRAME + variant.suffix),
        }),
      ).rejects.toThrow(variant.error);
      expect(vi.mocked(traceDebug)).toHaveBeenCalledWith(
        "model-gateway.server",
        "ollama.stream.terminated",
        expect.objectContaining({ outcome: "failed", endpoint: "raw" }),
      );
    },
  );

  test("redacts provider error content for requests carrying tool media", async () => {
    const requestBody: ModelGatewayRequest = {
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            kind: "tool_image_v1",
            id: "private-image-ref",
          }),
        },
      ],
      modelPolicy: POLICY,
    };
    const result = await createOllamaProviderAdapter({
      fallbackUrl: "http://unused.test",
    }).invoke({
      endpoint: "chat",
      requestBody,
      invocation: resolveModelInvocation(requestBody),
      fetchImpl: async () =>
        new Response('{"error":"PRIVATE_PIXELS private-image-ref"}\n'),
    });
    if (result.kind !== "chat") throw new Error("expected mock chat stream");
    const events: ModelGatewayEvent[] = [];
    await result.stream({ emit: (event) => events.push(event) });
    expect(events).toEqual([
      { type: "error", error: "tool_media_provider_error: content omitted" },
    ]);
    const diagnostics = vi
      .mocked(traceDebug)
      .mock.calls.filter(([, event]) => event === "ollama.stream.terminated");
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_PIXELS");
    expect(diagnostics[0]?.[2]).toMatchObject({ outcome: "failed" });
  });

  test("retains cancellation rather than emitting a provider failure event", async () => {
    const failure = Object.assign(new Error("request cancelled"), {
      name: "AbortError",
    });
    const requestBody = { text: "Synthetic QA", modelPolicy: POLICY };
    const result = await createOllamaProviderAdapter({
      fallbackUrl: "http://unused.test",
    }).invoke({
      endpoint: "chat",
      requestBody,
      invocation: resolveModelInvocation(requestBody),
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(failure);
            },
          }),
        ),
    });
    if (result.kind !== "chat") throw new Error("expected mock chat stream");
    const events: ModelGatewayEvent[] = [];
    await expect(
      result.stream({ emit: (event) => events.push(event) }),
    ).rejects.toBe(failure);
    expect(events).toEqual([]);
    expect(vi.mocked(traceDebug)).toHaveBeenCalledWith(
      "model-gateway.server",
      "ollama.stream.terminated",
      expect.objectContaining({ outcome: "aborted", abortRequested: true }),
    );
  });
});
