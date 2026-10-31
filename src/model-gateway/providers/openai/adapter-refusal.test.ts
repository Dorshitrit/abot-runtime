import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayEvent, ModelGatewayRequest } from "../../types.js";
import { createOpenAIProviderAdapter } from "./adapter.js";
import { controlsFormat } from "./__tests__/native-function-fixture.js";

const tracing = vi.hoisted(() => ({ enabled: false }));
vi.mock("../../observability/trace-store.js", () => ({
  isModelIoTraceEnabled: () => tracing.enabled,
  traceModelIo: vi.fn(async () => {}),
}));

const refusalText = "provider refusal must not become accepted output";
const refusalMessage = {
  id: "refusal-item", type: "message", phase: "final_answer",
  content: [{ type: "refusal", refusal: refusalText }],
};
const refusalCases = [
  { name: "refusal delta", event: { type: "response.refusal.delta", delta: refusalText } },
  { name: "refusal done", event: { type: "response.refusal.done", refusal: refusalText } },
  { name: "added item", event: { type: "response.output_item.added", item: refusalMessage } },
  { name: "completed item", event: { type: "response.output_item.done", item: refusalMessage } },
  { name: "completed response", event: { type: "response.completed", response: {
    status: "completed", output: [refusalMessage],
  } } },
];
const policy = {
  providers: { test: { type: "openai", apiKeyEnv: "REFUSAL_TEST_KEY" } },
  profiles: { test: { provider: "test", model: "fixture", contextWindowTokens: 32768 } },
  defaults: { profileId: "test" },
};
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

afterEach(() => { tracing.enabled = false; vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe.each([false, true])("OpenAI refusal boundary with tracing=%s", (enabled) => {
  describe.each(["chat", "raw"] as const)("%s", (endpoint) => {
    describe.each(["ordinary", "schema", "function"] as const)("%s output", (mode) => {
      test.each(refusalCases)("rejects $name without accepting output or waiting for EOF", async ({ event }) => {
        tracing.enabled = enabled;
        vi.stubEnv("REFUSAL_TEST_KEY", "fixture-only");
        const requestBody: ModelGatewayRequest = {
          modelPolicy: policy,
          modelStep: mode === "function" ? "capability.controls" : "execution.response",
          ...(mode === "schema" ? { format: "json" as const } : {}),
          ...(mode === "function" ? { format: controlsFormat } : {}),
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
          if (result.kind === "error") throw new Error(result.message);
          if (result.kind === "raw") return result.body;
          await result.stream({ emit: (value) => events.push(value) });
          const error = events.find((value) => value.type === "error");
          if (error?.type === "error") throw new Error(String(error.error));
          return events;
        })();
        controller.enqueue(new TextEncoder().encode(
          frame({ type: "response.output_item.added", output_index: 0,
            item: { id: "answer", type: "message", phase: "final_answer" } })
          + frame({ type: "response.output_text.delta", output_index: 0, item_id: "answer", delta: "provisional" })
          + frame(event),
        ));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await expect(Promise.race([operation, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("refusal still waits for EOF")), 1500);
          })])).rejects.toThrow("openai response refused");
          expect(events.some((value) => value.type === "done")).toBe(false);
          expect(JSON.stringify(events)).not.toContain(refusalText);
          if (endpoint === "chat") expect(events.filter((value) => value.type === "error")).toHaveLength(1);
          expect(cancel).toHaveBeenCalledOnce();
          expect(body.locked).toBe(false);
        } finally {
          clearTimeout(timer);
          if (!cancel.mock.calls.length) controller.close();
          await operation.catch(() => {});
        }
      });
    });
  });
});
