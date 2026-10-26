import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createExecutionAgentDecisionFormat } from "../../../runtime/steps/execution-agent/format.js";
import { parseExecutionAgentDecisionOutput } from "../../../runtime/steps/execution-agent/parser.js";
import type { ModelGatewayEvent, ModelGatewayRequest } from "../../types.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import { createOpenAIProviderAdapter } from "./adapter.js";
import { nativeRequest, sse } from "./__tests__/native-function-fixture.js";

const contractOptions = { allowPlanner: true };
const decisionFormat = createExecutionAgentDecisionFormat(contractOptions);
const decision = {
  action: "invoke_planner",
  objective: "Plan the requested connected project, including שלום and local data.",
};
const decisionArguments = ` {\n  "decision": ${JSON.stringify(decision)}\n} `;
const historyArguments = '{"capabilityId":"read_skill","controls":{"skillId":"technical-work"}}';
const historyResult = '{"outcome":"succeeded","observedEffect":"observation"}';
const requestBody: ModelGatewayRequest = {
  ...nativeRequest,
  agentMode: "fast",
  modelStep: "execution.decision",
  format: decisionFormat,
  messages: [
    { role: "user", content: "Build the requested project." },
    { role: "assistant", content: "", toolCalls: [
      { callId: "capability-execution-1", name: "runtime_capability", arguments: historyArguments },
    ] },
    { role: "tool", toolCallId: "capability-execution-1", toolName: "runtime_capability", content: historyResult },
  ],
};
const functionCall = {
  type: "function_call", id: "fc_decision", call_id: "decision-1", status: "completed",
  name: decisionFormat.name, arguments: decisionArguments,
};
const commentary = {
  type: "message", id: "commentary", phase: "commentary",
  content: [{ type: "output_text", text: '{"decision":{"action":"respond"}}' }],
};
const provisionalEvents = [
  { type: "response.output_item.added", output_index: 0, item: commentary },
  { type: "response.output_text.delta", item_id: commentary.id, output_index: 0,
    delta: commentary.content[0]!.text },
  { type: "response.output_item.added", output_index: 1,
    item: { ...functionCall, status: "in_progress", arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: functionCall.id,
    output_index: 1, delta: decisionArguments },
  { type: "response.function_call_arguments.done", item_id: functionCall.id,
    output_index: 1, arguments: decisionArguments },
  { type: "response.output_item.done", output_index: 1, item: functionCall },
];

function completedResponse(output: unknown[]) {
  return { type: "response.completed", response: { status: "completed", output } };
}

function invokeDecision(endpoint: "chat" | "raw", events: readonly unknown[]) {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(sse(events), {
    headers: { "Content-Type": "text/event-stream" },
  }));
  const outcome = createOpenAIProviderAdapter().invoke({
    endpoint, requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl,
  });
  return { fetchImpl, outcome };
}

beforeEach(() => vi.stubEnv("NATIVE_TEST_KEY", "fixture-only"));
afterEach(() => vi.unstubAllEnvs());

describe.each(["chat", "raw"] as const)("OpenAI Execution Agent native decision: %s", (endpoint) => {
  test("preserves tool history and returns only completed arguments to the runtime parser", async () => {
    const { fetchImpl, outcome } = invokeDecision(endpoint, [
      ...provisionalEvents, completedResponse([commentary, functionCall]),
    ]);
    const result = await outcome;
    expect(fetchImpl).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({
      reasoning: { effort: "none" },
      tools: [{ type: "function", name: decisionFormat.name, strict: true }],
      tool_choice: { type: "function", name: decisionFormat.name },
      parallel_tool_calls: false,
    });
    expect(payload.tools).toHaveLength(1);
    expect(payload).not.toHaveProperty("text");
    expect(payload).not.toHaveProperty("max_output_tokens");
    expect(payload.input.slice(-3)).toEqual([
      { role: "user", content: "Build the requested project." },
      { type: "function_call", call_id: "capability-execution-1",
        name: "runtime_capability", arguments: historyArguments },
      { type: "function_call_output", call_id: "capability-execution-1", output: historyResult },
    ]);
    expect(result.kind).toBe(endpoint);
    let text = "";
    if (result.kind === "raw") {
      expect(result.body.text).toBe(decisionArguments);
      text = String(result.body.text);
    }
    if (result.kind === "chat") {
      const events: ModelGatewayEvent[] = [];
      await result.stream({ emit: (event) => events.push(event) });
      expect(events).toEqual([
        { type: "content", text: decisionArguments },
        { type: "done", done: true, doneReason: null },
      ]);
      text = events.flatMap((event) => event.type === "content" ? [event.text] : []).join("");
    }
    expect(text).toBe(decisionArguments);
    expect(parseExecutionAgentDecisionOutput(text, contractOptions)).toEqual({ ok: true, decision });
    expect(parseExecutionAgentDecisionOutput(text, { allowPlanner: false })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "execution_agent_planner_not_allowed" })]),
    });
  });

  test.each([
    ["partial call without terminal response", undefined, "not completed"],
    ["commentary without a function", completedResponse([commentary]), "exactly one call"],
    ["multiple calls", completedResponse([functionCall, { ...functionCall, call_id: "decision-2" }]), "exactly one call"],
    ["wrong function name", completedResponse([{ ...functionCall, name: "runtime_capability" }]), "name mismatch"],
    ["in-progress terminal call", completedResponse([{ ...functionCall, status: "in_progress" }]), "not completed"],
  ] as const)("rejects %s without exposing a decision or success", async (_name, terminal, message) => {
    const { fetchImpl, outcome } = invokeDecision(endpoint, [
      ...provisionalEvents, ...(terminal ? [terminal] : []),
    ]);
    if (endpoint === "raw") {
      await expect(outcome).rejects.toThrow(message);
      expect(fetchImpl).toHaveBeenCalledOnce();
      return;
    }
    const result = await outcome;
    expect(result.kind).toBe("chat");
    if (result.kind !== "chat") throw new Error("Expected chat stream");
    const events: ModelGatewayEvent[] = [];
    await result.stream({ emit: (event) => events.push(event) });
    expect(events).toEqual([{ type: "error", error: expect.stringContaining(message) }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
