import { expect, test } from "vitest";
import profileData from "../model-parameter-profiles/builtin/gpt-oss.json" with { type: "json" };
import type { ModelParameterProfile } from "../../shared/model-parameters.js";
import type { ModelGatewayRequest, ModelGenerationConfig } from "../types.js";
import { resolveModelInvocation } from "./invocation-policy.js";
import { buildLlamaCppChatPayload } from "../providers/llamacpp/payload.js";
import { buildOpenAIInputTokenCountPayload, buildOpenAIResponsesPayload } from "../providers/openai/payload.js";
import { buildChatGptResponsesPayload } from "../providers/openai-chatgpt/payload.js";

function request(provider: string, generation: ModelGenerationConfig): ModelGatewayRequest {
  return { text: "hello", agentMode: "deep", modelPolicy: {
    providers: { local: { type: provider } },
    profiles: { local: { provider: "local", model: "gpt-oss:20b", contextWindowTokens: 4096, supportsThinking: true, generation } },
    defaults: { profileId: "local" }, parameterProfiles: { schemaVersion: 1, revision: "fixture", diagnostics: [],
      profiles: [profileData as ModelParameterProfile] },
  } };
}

function llama(input: ModelGatewayRequest) {
  return buildLlamaCppChatPayload({ requestBody: input, invocation: resolveModelInvocation(input), endpoint: "chat" });
}

test.each(["fast", "reasoning", "deep"])("mapped canonical omission survives %s fallback and configured mode budget", (agentMode) => {
  const input = request("llamacpp", { parameters: { reasoning_effort: { mode: "value", value: "none" } },
    reasoningBudgetByMode: { fast: 8, reasoning: 16, deep: 32 } });
  input.agentMode = agentMode;
  const before = structuredClone(input);
  const invocation = resolveModelInvocation(input);
  expect(invocation.think).toBeUndefined();
  expect(invocation.reasoningBudget).toBeUndefined();
  expect(invocation.parameters?.fields.reasoning_effort).toMatchObject({ omitted: true,
    warnings: [expect.objectContaining({ code: "model_reasoning_effort_omitted" })] });
  const payload = llama(input);
  for (const key of ["reasoning_effort", "reasoning_budget_tokens", "chat_template_kwargs"]) expect(payload).not.toHaveProperty(key);
  expect(input).toEqual(before);
});

test("explicit higher-priority effort can replace a mapped omission", () => {
  const input = request("llamacpp", { parameters: { reasoning_effort: { mode: "value", value: "none" } } });
  expect(llama({ ...input, reasoningOverride: "high" })).toHaveProperty("reasoning_effort", "high");
  expect(llama({ ...input, reasoningPreference: { profileId: "local", mode: "budget", budgetTokens: 64 } }))
    .toMatchObject({ reasoning_effort: "high", reasoning_budget_tokens: 64 });
});

test.each([false, undefined])("resolved known reasoning reaches OpenAI with legacy declaration %s", (supportsThinking) => {
  const input = request("openai", { parameters: { reasoning_effort: { mode: "value", value: "high" } } });
  input.modelPolicy!.profiles!.local!.supportsThinking = supportsThinking;
  expect(resolveModelInvocation(input).think).toBe("high");
  expect(buildOpenAIResponsesPayload(input)).toHaveProperty("reasoning.effort", "high");
  expect(buildOpenAIInputTokenCountPayload(input)).toHaveProperty("reasoning.effort", "high");
  input.modelPolicy!.providers!.local!.type = "openai-chatgpt";
  expect(buildChatGptResponsesPayload(input)).toHaveProperty("reasoning.effort", "high");
});

test("known capability alone does not change legacy undeclared reasoning", () => {
  const input = request("openai", {});
  delete input.modelPolicy!.profiles!.local!.supportsThinking;
  expect(buildOpenAIResponsesPayload(input)).not.toHaveProperty("reasoning");
  delete input.modelPolicy!.parameterProfiles;
  input.modelPolicy!.profiles!.local!.generation = { reasoningEffort: "high" };
  expect(buildOpenAIResponsesPayload(input)).not.toHaveProperty("reasoning");
});

test("forbidden reasoning budget removes and diagnoses legacy server-default sentinel", () => {
  const input = request("llamacpp", { reasoningEffort: "high", reasoningBudget: { mode: "server-default" } });
  const catalog = input.modelPolicy!.parameterProfiles!;
  input.modelPolicy!.parameterProfiles = { ...catalog, profiles: [{ ...catalog.profiles[0],
    constraints: { ...catalog.profiles[0].constraints, thinking_budget: { supported: false } } }] };
  const invocation = resolveModelInvocation(input);
  expect(invocation.reasoningBudget).toBeUndefined();
  expect(invocation.parameters?.fields.thinking_budget).toMatchObject({ supported: false, omitted: true,
    warnings: [expect.objectContaining({ code: "model_parameter_unsupported" })] });
  expect(llama(input)).not.toHaveProperty("reasoning_budget_tokens");
  delete input.modelPolicy!.parameterProfiles;
  expect(llama(input)).toHaveProperty("reasoning_budget_tokens", -1);
});
