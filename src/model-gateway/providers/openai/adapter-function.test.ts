import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayEvent } from "../../types.js";
import { traceModelIo } from "../../observability/trace-store.js";
import { createOpenAIProviderAdapter } from "./adapter.js";
import { bindOpenAIResponseLifetime } from "./response-lifetime.js";
import { collectOpenAIResponsesStream } from "./stream.js";
import {
  completedFunction, controlsFormat, frame, functionArguments, nativeRequest, preamble,
} from "./__tests__/native-function-fixture.js";

const tracing = vi.hoisted(() => ({ enabled: false }));
vi.mock("../../observability/trace-store.js", () => ({
  isModelIoTraceEnabled: () => tracing.enabled,
  traceModelIo: vi.fn(async () => {}),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe.each([false, true])("native OpenAI terminal lifecycle tracing=%s", (enabled) => {
  test.each(["chat", "raw"] as const)("%s finishes without waiting for provider EOF", async (endpoint) => {
    tracing.enabled = enabled;
    vi.stubEnv("NATIVE_TEST_KEY", "fixture-only");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    // Even a cleanup promise that never settles cannot delay protocol completion.
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body));
    const operation = (async () => {
      const result = await createOpenAIProviderAdapter().invoke({
        endpoint, requestBody: nativeRequest, invocation: resolveModelInvocation(nativeRequest), fetchImpl,
      });
      if (result.kind !== "chat") return result;
      const events: ModelGatewayEvent[] = [];
      await result.stream({ emit: (event) => events.push(event) });
      return events;
    })();
    const wire = [...preamble, completedFunction].map(frame).join("");
    controller.enqueue(new TextEncoder().encode(wire));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("completed function still waits for EOF")), 1500);
      })]);
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      if (endpoint === "chat") expect(result).toEqual([
        { type: "content", text: functionArguments },
        { type: "done", done: true, doneReason: null, usage },
      ]);
      else expect(result).toEqual({ kind: "raw", body: { text: functionArguments, thinking: "", usage } });
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
        tool_choice: { type: "function", name: controlsFormat.name },
      });
      if (enabled) expect(traceModelIo).toHaveBeenLastCalledWith(expect.objectContaining({
        event: "provider.response", response: expect.objectContaining({
          body: wire, decoded: expect.objectContaining({ text: functionArguments, usage }),
        }),
      }));
    } finally {
      clearTimeout(timer);
      if (!cancel.mock.calls.length) controller.close();
      await operation;
    }
  });

  test.each(["chat", "raw"] as const)("%s releases a failed response with no EOF, including the trace reader", async (endpoint) => {
    tracing.enabled = enabled;
    vi.stubEnv("NATIVE_TEST_KEY", "fixture-only");
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame({
          type: "response.failed", response: { status: "failed", error: { message: "fixture provider failure" } },
        })));
      }, cancel,
    });
    const operation = createOpenAIProviderAdapter().invoke({
      endpoint, requestBody: nativeRequest, invocation: resolveModelInvocation(nativeRequest),
      fetchImpl: async () => new Response(body),
    });
    if (endpoint === "raw") await expect(operation).rejects.toThrow("fixture provider failure");
    else {
      const result = await operation;
      if (result.kind !== "chat") throw new Error("expected chat");
      const events: ModelGatewayEvent[] = [];
      await result.stream({ emit: (event) => events.push(event) });
      expect(events).toEqual([{ type: "error", error: "fixture provider failure" }]);
    }
    expect(cancel).toHaveBeenCalledOnce();
  });
});

test("cancellation before a completed response releases the native stream and retains its cause", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const upstream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const options = { functionOutputName: controlsFormat.name };
  const response = bindOpenAIResponseLifetime(new Response(upstream), options);
  const operation = collectOpenAIResponsesStream(response.body!, options);
  const failure = new DOMException("caller cancelled", "AbortError");
  controller.enqueue(new TextEncoder().encode(preamble.map(frame).join("")));
  controller.error(failure);
  await expect(operation).rejects.toBe(failure);
  expect(upstream.locked).toBe(false);
});
