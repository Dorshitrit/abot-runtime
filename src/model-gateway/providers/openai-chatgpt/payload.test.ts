import { expect, test } from "vitest";
import { createExecutionAgentDecisionFormat } from "../../../runtime/steps/execution-agent/format.js";
import { createSemanticCompactionFormat } from "../../../runtime/context/semantic-compaction/format.js";
import { semanticContractFixture } from "../../../runtime/__tests__/support/semantic-compaction-contract-fixture.js";
import { assertFinalProviderEnvelopeFits } from "../../observability/context-window-guard.js";
import { createProviderTraceContext } from "../../observability/provider-trace-context.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import { controlsFormat } from "../openai/__tests__/native-function-fixture.js";
import { buildOpenAIResponsesPayload } from "../openai/payload.js";
import { buildChatGptResponsesPayload } from "./payload.js";
import { messages as originalMessages, request } from "./__tests__/fixture.js";

test("maps only system roles at their original positions and preserves tool receipt identities and bytes", () => {
  const messages = [
    ...originalMessages,
    { role: "assistant" as const, content: "", toolCalls: [{ callId: "e1", name: "runtime_capability", arguments: ' {"x":"שלום"} ' }] },
    { role: "tool" as const, toolCallId: "e1", toolName: "runtime_capability", content: "exact tool result\n" },
    { role: "system" as const, content: "late repair instruction\n" },
  ];
  const before = structuredClone(messages);
  const payload = buildChatGptResponsesPayload({ ...request, messages });
  expect(payload.input).toEqual([
    { role: "developer", content: "Keep the caller's policy." }, messages[1],
    { type: "function_call", call_id: "e1", name: "runtime_capability", arguments: ' {"x":"שלום"} ' },
    { type: "function_call_output", call_id: "e1", output: "exact tool result\n" },
    { role: "developer", content: "late repair instruction\n" },
  ]);
  expect(messages).toEqual(before);
  expect((buildOpenAIResponsesPayload({ ...request, messages }).input as unknown[])[0]).toMatchObject({ role: "system" });
});

test.each([
  ["capability.controls", controlsFormat],
  ["execution.decision", createExecutionAgentDecisionFormat({ allowPlanner: true, allowUserInteraction: true })],
  ["context.compact", createSemanticCompactionFormat([semanticContractFixture({ policy: "execution-agent-v1" }).source], 1024)],
] as const)("%s keeps the existing exact schema and forced output identity in additional_tools", (modelStep, format) => {
  const input = { ...request, modelStep, format, agentMode: "fast" as const };
  const standard = buildOpenAIResponsesPayload(input);
  const payload = buildChatGptResponsesPayload(input);
  expect(payload).toMatchObject({ stream: true, store: false, tool_choice: { type: "function", name: format.name }, parallel_tool_calls: false });
  expect((payload.input as unknown[]).at(-1)).toEqual({ type: "additional_tools", role: "developer", tools: standard.tools });
  expect(payload).not.toHaveProperty("tools");
  expect(payload).not.toHaveProperty("text");
  expect(payload).not.toHaveProperty("temperature");
  expect(payload).not.toHaveProperty("top_p");
  expect(payload).not.toHaveProperty("max_output_tokens");
});

test("plain input is always an array and SUPER JSON output retains its existing format", () => {
  expect(buildChatGptResponsesPayload({ ...request, messages: undefined, prompt: "exact\n" }).input)
    .toEqual([{ role: "user", content: "exact\n" }]);
  const input = { ...request, modelStep: "supervisor.decision", format: controlsFormat };
  expect(buildChatGptResponsesPayload(input).text).toEqual(buildOpenAIResponsesPayload(input).text);
  expect(buildChatGptResponsesPayload(input)).not.toHaveProperty("tool_choice");
});

test("final-envelope admission includes additional_tools and developer projections without exact-count calls", () => {
  const requestBody = { ...request, modelStep: "capability.controls", format: controlsFormat };
  const invocation = resolveModelInvocation(requestBody);
  const context = createProviderTraceContext({ endpoint: "raw", requestBody, invocation });
  const payload = buildChatGptResponsesPayload(requestBody);
  const largeTool = { type: "additional_tools", role: "developer", tools: [{ description: "schema evidence ".repeat(50000) }] };
  expect(() => assertFinalProviderEnvelopeFits({ context, invocation, payload })).not.toThrow();
  expect(() => assertFinalProviderEnvelopeFits({ context, invocation, payload: { ...payload, input: [largeTool] } }))
    .toThrow("model_context_window_exceeded");
});
