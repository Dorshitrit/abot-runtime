import { afterEach, expect, test, vi } from "vitest";
import { createSupervisorProcedureGateFormat } from "../../runtime/steps/supervisor-decision/procedure-gate.js";
import { createModelProviderAdapterRegistry } from "../providers/contracts.js";
import * as envelopeBudget from "../providers/envelope-budget.js";
import { createOllamaProviderAdapter } from "../providers/ollama/adapter.js";
import { createOpenAIProviderAdapter } from "../providers/openai/adapter.js";
import { createChatGptProviderAdapter } from "../providers/openai-chatgpt/adapter.js";
import { accountRef, completed, response as sseResponse } from "../providers/openai-chatgpt/__tests__/fixture.js";
import type { ModelGatewayPolicyConfig, ModelGatewayRequest } from "../types.js";
import { createChatHandler } from "./chat-handler.js";
import type { GatewayResponse } from "./contracts.js";
import { createInputTokenCountHandler } from "./input-token-count-handler.js";
import { createInputTokenMeasurementStore } from "./input-token-measurements.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const note = { role: "system", content: "Decide whether the request needs a procedure." } as const;
const skill = { role: "user", content: "Selected skill reference." } as const;
const request = { role: "user", content: "Build the project." } as const;
const lookup = { action: "recall_memory", query: "יישום קודם" };
const call = { callId: "settled-recall-1", name: lookup.action, arguments: JSON.stringify(lookup) };
const receipt = "Latest explicit lookup: no matching memories.";
const invocation: ModelGatewayRequest = {
  modelStep: "supervisor.decision",
  format: createSupervisorProcedureGateFormat(),
  messages: [
    note, skill, request,
    { role: "assistant", content: "", toolCalls: [call] },
    { role: "tool", toolCallId: call.callId, toolName: call.name, content: receipt },
  ],
};

const providers = [
  { type: "openai", apiKeyEnv: "TEST_RECALL_WIRE", baseUrl: "https://openai.test/v1" },
  { type: "openai-chatgpt", settings: { accountRef } },
  { type: "ollama" },
] as const;

test.each(providers)("$type budgets the same linked recall history it sends for a structured decision", async (provider) => {
  vi.stubEnv("TEST_RECALL_WIRE", "test-only");
  const providerAdapters = createModelProviderAdapterRegistry([
    createOpenAIProviderAdapter(),
    createChatGptProviderAdapter({ getAccessToken: async () => "test-only" }),
    createOllamaProviderAdapter({ fallbackUrl: "http://ollama.test" }),
  ]);
  const modelPolicy: ModelGatewayPolicyConfig = {
    providers: { fixture: provider },
    profiles: { fixture: { provider: "fixture", model: "fixture", contextWindowTokens: 32_768 } },
    defaults: { profileId: "fixture" },
  };
  const fetchImpl = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith("/input_tokens")) return Response.json({ input_tokens: 100 });
    if (provider.type === "ollama") return Response.json({ message: { content: "response" }, done: true });
    return sseResponse([completed]);
  });
  const assess = vi.spyOn(envelopeBudget, "resolveProviderEnvelopeInputTokens");
  const response = { setHeader: vi.fn(), write: vi.fn(), end: vi.fn() } satisfies GatewayResponse;
  const options = { providerAdapters, modelPolicy, fetchImpl };
  const measurements = createInputTokenMeasurementStore();
  if (provider.type === "openai") {
    await createInputTokenCountHandler(options, measurements)(invocation, response);
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining('"inputTokens":100'));
  }
  await createChatHandler(options, measurements)(invocation, response);
  expect(response.write).toHaveBeenCalledWith(expect.stringContaining('"type":"done"'));
  const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  const sent = bodies.at(-1);
  expect(sent).not.toHaveProperty("tools");
  if (provider.type === "openai") {
    expect(bodies).toHaveLength(2);
    expect(bodies[0].input).toEqual(sent.input);
    expect(bodies[0].text).toEqual(sent.text);
  } else {
    expect(bodies).toHaveLength(1);
    expect(assess.mock.calls[0]![0].payload).toEqual(sent);
  }
  if (provider.type === "ollama") {
    expect(sent.format).toHaveProperty("properties.decision");
    expect(sent.messages).toEqual([
      note, skill, request,
      { role: "assistant", tool_calls: [{ type: "function", function: { index: 0, name: call.name, arguments: lookup } }] },
      { role: "tool", tool_name: call.name, content: receipt },
    ]);
  } else {
    expect(sent.text.format.name).toBe("supervisor_procedure_gate");
    expect(sent.input).toEqual([
      { role: provider.type === "openai" ? "system" : "developer", content: note.content }, skill, request,
      { type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments },
      { type: "function_call_output", call_id: call.callId, output: receipt },
    ]);
  }
});
