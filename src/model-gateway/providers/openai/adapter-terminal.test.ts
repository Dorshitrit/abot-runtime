import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayEvent, ModelGatewayRequest } from "../../types.js";
import { traceModelIo } from "../../observability/trace-store.js";
import { createOpenAIProviderAdapter } from "./adapter.js";

const tracing = vi.hoisted(() => ({ enabled: false }));
vi.mock("../../observability/trace-store.js", () => ({
  isModelIoTraceEnabled: () => tracing.enabled,
  traceModelIo: vi.fn(async () => {}),
}));

const request: ModelGatewayRequest = {
  modelStep: "execution.decision",
  modelPolicy: {
    providers: { test: { type: "openai", apiKeyEnv: "TERMINAL_TEST_KEY" } },
    profiles: { test: { provider: "test", model: "fixture", contextWindowTokens: 32768 } },
    defaults: { profileId: "test" },
  },
};
const encoder = new TextEncoder();
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const delta = frame({ type: "response.output_text.delta", delta: "answer" });
const completed = frame({ type: "response.completed", response: {
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
} });

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe.each([false, true])("OpenAI terminal lifecycle with tracing=%s", (enabled) => {
  test.each(["chat", "raw"] as const)("%s finishes and releases an upstream that never sends EOF", async (endpoint) => {
    tracing.enabled = enabled;
    vi.stubEnv("TERMINAL_TEST_KEY", "fixture-only");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; }, cancel,
    });
    const operation = (async () => {
      const result = await createOpenAIProviderAdapter().invoke({
        endpoint, requestBody: request, invocation: resolveModelInvocation(request),
        fetchImpl: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      });
      if (result.kind !== "chat") return result;
      const events: ModelGatewayEvent[] = [];
      await result.stream({ emit: (event) => events.push(event) });
      return events;
    })();
    controller.enqueue(encoder.encode(delta + completed));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("terminal still waits for EOF")), 1500);
      })]);
      if (endpoint === "chat") {
        expect(result).toEqual([
          { type: "content", text: "answer" },
          { type: "done", done: true, doneReason: null, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
        ]);
      } else {
        expect(result).toEqual({ kind: "raw", body: {
          text: "answer", thinking: "", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        } });
      }
      expect(cancel).toHaveBeenCalledOnce();
      if (enabled) expect(traceModelIo).toHaveBeenLastCalledWith(expect.objectContaining({
        event: "provider.response", response: expect.objectContaining({
          body: delta + completed, decoded: expect.objectContaining({ text: "answer" }),
        }),
      }));
    } finally {
      clearTimeout(timer);
      if (!cancel.mock.calls.length) controller.close();
      await operation;
    }
  });
});
