import { afterEach, describe, expect, test, vi } from "vitest";
import type { ModelGatewayEvent, ModelGatewayRequest } from "../../types.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import { createOpenAIProviderAdapter } from "./adapter.js";

const expectedText = '{"action":"respond"}';
const policy = {
  providers: { openai: { type: "openai", baseUrl: "https://phase.test/v1", apiKeyEnv: "OPENAI_PHASE_TEST_KEY" } },
  profiles: { model: { provider: "openai", model: "phase-test", contextWindowTokens: 120_000, supportsThinking: true } },
  defaults: { profileId: "model" },
} as const;

function responseEvents(): string {
  const events: unknown[] = [];
  for (const [index, phase, text] of [[0, "commentary", "I will choose an action."], [1, "final_answer", expectedText]] as const) {
    const item = { id: `msg-${index}`, type: "message", role: "assistant", phase };
    events.push({ type: "response.output_item.added", output_index: index, item });
    events.push({ type: "response.output_text.delta", output_index: index, item_id: item.id, delta: text });
    events.push({ type: "response.output_item.done", output_index: index, item });
  }
  events.push({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } });
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

afterEach(() => vi.unstubAllEnvs());

describe.each(["chat", "raw"] as const)("OpenAI %s structured output contract", (endpoint) => {
  test.each([["fast", "none"], ["reasoning", "medium"], ["deep", "high"]] as const)(
    "selects the same final answer in %s mode", async (agentMode, effort) => {
      vi.stubEnv("OPENAI_PHASE_TEST_KEY", "test-key");
      const requestBody: ModelGatewayRequest = {
        agentMode, modelStep: "worker.decision", modelPolicy: policy,
        messages: [{ role: "user", content: "Choose the next action." }],
        format: { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false },
      };
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(responseEvents(), {
        headers: { "Content-Type": "text/event-stream" },
      }));
      const result = await createOpenAIProviderAdapter().invoke({
        endpoint, requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl,
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      const payload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
      expect(payload.reasoning).toEqual({ effort });
      expect(payload.text.format.type).toBe("json_schema");
      expect(payload).not.toHaveProperty("tools");
      expect(result.kind).toBe(endpoint);
      if (result.kind === "chat") {
        const events: ModelGatewayEvent[] = [];
        await result.stream({ emit: (event) => events.push(event) });
        expect(events).toEqual([
          { type: "content", text: expectedText },
          { type: "done", done: true, doneReason: null, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
        ]);
        return;
      }
      expect(result).toEqual({ kind: "raw", body: {
        text: expectedText, thinking: "", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      } });
    },
  );
});
