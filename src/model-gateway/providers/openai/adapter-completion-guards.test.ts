import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayEvent, ModelGatewayRequest } from "../../types.js";
import { createOpenAIProviderAdapter } from "./adapter.js";

const tracing = vi.hoisted(() => ({ enabled: false }));
vi.mock("../../observability/trace-store.js", () => ({
  isModelIoTraceEnabled: () => tracing.enabled,
  traceModelIo: vi.fn(async () => {}),
}));

const text = '{"action":"respond","text":"valid output"}';
const policy = {
  providers: { test: { type: "openai", apiKeyEnv: "COMPLETION_GUARD_TEST_KEY" } },
  profiles: { test: { provider: "test", model: "fixture", contextWindowTokens: 32768 } },
  defaults: { profileId: "test" },
};
type OutputMode = "decision" | "payload" | "ordinary";
type Ending = "failed" | "eof" | "done" | "completed" | "max_output_tokens";
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

async function invokeResponse(endpoint: "chat" | "raw", mode: OutputMode, ending: Ending) {
  vi.stubEnv("COMPLETION_GUARD_TEST_KEY", "fixture-only");
  const requestBody: ModelGatewayRequest = {
    modelPolicy: policy,
    modelStep: mode === "payload" ? "tool_payload.raw" : "execution.decision",
    ...(mode === "decision" ? { format: "json" as const } : {}),
  };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const events: ModelGatewayEvent[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; }, cancel,
  });
  const operation = (async () => {
    const result = await createOpenAIProviderAdapter().invoke({
      endpoint, requestBody, invocation: resolveModelInvocation(requestBody),
      fetchImpl: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    });
    if (result.kind === "raw") return result.body;
    if (result.kind === "error") throw new Error(result.message);
    await result.stream({ emit: (event) => events.push(event) });
    const error = events.find((event) => event.type === "error");
    if (error?.type === "error") {
      expect(events.filter((event) => event.type === "error")).toHaveLength(1);
      expect(events.some((event) => event.type === "done")).toBe(false);
      throw new Error(String(error.error));
    }
    return {
      text: events.flatMap((event) => event.type === "content" ? [event.text] : []).join(""),
      providerCompletionReason: events.find((event) => event.type === "done")?.doneReason,
    };
  })();
  let wire = frame({ type: "response.output_item.added", output_index: 0,
    item: { id: "answer", type: "message", phase: "final_answer" } })
    + frame({ type: "response.output_text.delta", output_index: 0, item_id: "answer", delta: text });
  if (ending === "failed") wire += frame({ type: "response.failed", response: { error: { message: "provider failed explicitly" } } });
  if (ending === "done") wire += "data: [DONE]\n\n";
  if (ending === "completed") wire += frame({ type: "response.completed", response: { status: "completed" } });
  if (ending === "max_output_tokens") wire += frame({ type: "response.incomplete",
    response: { incomplete_details: { reason: "max_output_tokens" } } });
  controller.enqueue(new TextEncoder().encode(wire));
  if (ending === "eof") controller.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("terminal still waits for EOF")), 1500);
    })]);
  } finally {
    clearTimeout(timer);
    if (ending !== "eof" && !cancel.mock.calls.length) controller.close();
    await operation.catch(() => {});
    if (ending !== "eof") expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  }
}

afterEach(() => { tracing.enabled = false; vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe.each([false, true])("OpenAI completion guards with tracing=%s", (enabled) => {
  describe.each(["chat", "raw"] as const)("%s output", (endpoint) => {
    test.each(["decision", "payload", "ordinary"] as const)(
      "rejects response.failed for %s while upstream remains open", async (mode) => {
        tracing.enabled = enabled;
        await expect(invokeResponse(endpoint, mode, "failed")).rejects.toThrow("provider failed explicitly");
      },
    );

    describe.each(["decision", "payload", "ordinary"] as const)("%s completion", (mode) => {
      test.each(["eof", "done"] as const)("rejects valid content ending in %s", async (ending) => {
        tracing.enabled = enabled;
        await expect(invokeResponse(endpoint, mode, ending)).rejects.toThrow("openai response not completed");
      });

      test("accepts completion without waiting for provider EOF", async () => {
        tracing.enabled = enabled;
        await expect(invokeResponse(endpoint, mode, "completed")).resolves.toMatchObject({ text });
      });

      test("preserves max_output_tokens for the runtime rejection guard", async () => {
        tracing.enabled = enabled;
        await expect(invokeResponse(endpoint, mode, "max_output_tokens"))
          .resolves.toMatchObject({ text, providerCompletionReason: "max_output_tokens" });
      });
    });
  });
});
