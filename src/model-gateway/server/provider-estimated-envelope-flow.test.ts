import { afterEach, expect, test, vi } from "vitest";
import * as envelopeBudget from "../providers/envelope-budget.js";
import { createModelProviderAdapterRegistry } from "../providers/contracts.js";
import { createOllamaProviderAdapter } from "../providers/ollama/adapter.js";
import { createChatGptProviderAdapter } from "../providers/openai-chatgpt/adapter.js";
import { accountRef, response as chatGptResponse } from "../providers/openai-chatgpt/__tests__/fixture.js";
import { completedFunction, controlsFormat, functionArguments } from "../providers/openai/__tests__/native-function-fixture.js";
import type { ChatMessage, ModelGatewayPolicyConfig } from "../types.js";
import { createChatHandler } from "./chat-handler.js";
import type { GatewayResponse } from "./contracts.js";

afterEach(() => vi.restoreAllMocks());

const policy = { role: "system", content: "Act on the current assignment." } as const;
const user = { role: "user", content: "Read the selected file." } as const;
const repair = { role: "system", content: "Correct the rejected path.\n" } as const;
const call = { callId: "read-1", name: "runtime_capability", arguments: ' {"path":"שלום"} ' };
const output = "Exact result.\n";
const messages: ChatMessage[] = [
  policy, user, { role: "assistant", content: "", toolCalls: [call] },
  { role: "tool", toolCallId: call.callId, toolName: call.name, content: output }, repair,
];

const ollama = {
  provider: { type: "ollama" },
  adapter: createOllamaProviderAdapter({ fallbackUrl: "http://ollama.test" }),
  reply: () => new Response(JSON.stringify({ message: { role: "assistant", content: functionArguments }, done: true })),
  wire: {
    format: expect.any(Object),
    messages: [
      policy, user, { role: "assistant", tool_calls: [{ type: "function", function: {
        index: 0, name: call.name, arguments: { path: "שלום" },
      } }] },
      { role: "tool", tool_name: call.name, content: output }, repair,
    ],
  },
};
const chatGpt = {
  provider: { type: "openai-chatgpt", settings: { accountRef } },
  adapter: createChatGptProviderAdapter({ getAccessToken: async () => "fixture-token" }),
  reply: () => chatGptResponse([completedFunction]),
  wire: {
    input: [
      { role: "developer", content: policy.content }, user,
      { type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments },
      { type: "function_call_output", call_id: call.callId, output },
      { role: "developer", content: repair.content },
      { type: "additional_tools", role: "developer", tools: expect.any(Array) },
    ],
  },
};

test.each([ollama, chatGpt])("$provider.type estimates the dispatched chat envelope and rejects it at capacity", async (fixture) => {
  const assess = vi.spyOn(envelopeBudget, "resolveProviderEnvelopeInputTokens");
  const fetchImpl = vi.fn<typeof fetch>(async () => fixture.reply());
  const providerAdapters = createModelProviderAdapterRegistry([fixture.adapter]);
  const request = { messages, format: controlsFormat, modelStep: "capability.controls" };
  const original = structuredClone(request);

  async function dispatch(contextWindowTokens: number) {
    const modelPolicy: ModelGatewayPolicyConfig = {
      providers: { fixture: fixture.provider },
      profiles: { fixture: { provider: "fixture", model: "fixture", contextWindowTokens } },
      defaults: { profileId: "fixture" },
    };
    const response = { setHeader: vi.fn(), write: vi.fn(), end: vi.fn() } satisfies GatewayResponse;
    await createChatHandler({ providerAdapters, modelPolicy, fetchImpl })(request, response);
    return response;
  }

  const accepted = await dispatch(32_768);
  expect(accepted.write).toHaveBeenCalledWith(expect.stringContaining('"type":"done"'));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const dispatched = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
  expect(dispatched).toMatchObject(fixture.wire);
  expect(assess).toHaveBeenCalledTimes(1);
  const [assessmentInput] = assess.mock.calls[0]!;
  expect(assessmentInput.payload).toEqual(dispatched);
  const tokens = envelopeBudget.estimateProviderEnvelopeInputTokens(dispatched, assessmentInput.tokenEstimation);
  expect(assess).toHaveReturnedWith({
    inputTokens: tokens, measurement: "estimated", source: "runtime_token_estimator", measurementBinding: "missing",
  });

  const rejected = await dispatch(tokens);
  expect(rejected.end).toHaveBeenCalledWith("model_context_window_exceeded");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(request).toEqual(original);
});
