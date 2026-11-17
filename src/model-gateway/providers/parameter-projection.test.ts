import { afterEach, beforeEach, expect, test, vi } from "vitest";
import builtInProfile from "../model-parameter-profiles/builtin/gpt-oss.json" with { type: "json" };
import type { ModelParameterControls, ModelParameterProfile, ModelParameterProfileCatalog } from "../../shared/model-parameters.js";
import type { ModelGatewayPolicyConfig, ModelGatewayRequest, ModelGenerationConfig } from "../types.js";
import { resolveModelInvocation } from "../policy/invocation-policy.js";
import { buildLlamaCppChatPayload } from "./llamacpp/payload.js";
import { buildOllamaPayload, buildOllamaRawPayload } from "./ollama/payload.js";
import { buildOpenAIInputTokenCountPayload, buildOpenAIResponsesPayload } from "./openai/payload.js";
import { buildChatGptResponsesPayload } from "./openai-chatgpt/payload.js";

const catalog: ModelParameterProfileCatalog = { schemaVersion: 1, revision: "test", diagnostics: [], profiles: [builtInProfile as ModelParameterProfile] };
beforeEach(() => vi.stubEnv("OLLAMA_NUM_PREDICT", ""));
afterEach(() => vi.unstubAllEnvs());

function request(provider: string, generation: ModelGenerationConfig = {}, matching = false): ModelGatewayRequest {
  const modelPolicy: ModelGatewayPolicyConfig = {
    providers: { local: { type: provider } },
    profiles: { local: { provider: "local", model: matching ? "gpt-oss:20b" : "unknown", supportsThinking: true,
      contextWindowTokens: 4096, generation } }, defaults: { profileId: "local" },
    ...(matching ? { parameterProfiles: catalog } : {}),
  };
  return { text: "hello", agentMode: "deep", modelPolicy };
}
function llama(input: ModelGatewayRequest) {
  return buildLlamaCppChatPayload({ requestBody: input, invocation: resolveModelInvocation(input), endpoint: "chat" });
}

test("applying all recommended values reaches the exact llama.cpp wire fields, including zeros", () => {
  const parameters: ModelParameterControls = Object.fromEntries(Object.entries(builtInProfile.defaults).map(([key, value]) => [key, { mode: "value", value }]));
  const payload = llama(request("llamacpp", { parameters }, true));
  expect(payload).toMatchObject({ temperature: 1, top_p: 1, top_k: 0, min_p: 0, repeat_penalty: 1 });
  expect(payload).not.toHaveProperty("n_predict");
  expect(payload).not.toHaveProperty("parameters");
});

test("explicit output maps separately to each transport and input counting omits generation caps", () => {
  const generation = { parameters: { max_output_tokens: { mode: "value" as const, value: 123 } } };
  expect(llama(request("llamacpp", generation))).toHaveProperty("n_predict", 123);
  expect(buildOllamaPayload(request("ollama", generation))).toHaveProperty("options.num_predict", 123);
  expect(buildOpenAIResponsesPayload(request("openai", generation))).toHaveProperty("max_output_tokens", 123);
  expect(buildOpenAIInputTokenCountPayload(request("openai", generation))).not.toHaveProperty("max_output_tokens");
  expect(buildChatGptResponsesPayload(request("openai-chatgpt", generation))).not.toHaveProperty("max_output_tokens");
});

test.each(["chat", "raw"])("Ollama %s omit beats env/native/derived defaults while absent preserves them", (endpoint) => {
  const build = endpoint === "chat" ? buildOllamaPayload : buildOllamaRawPayload;
  vi.stubEnv("OLLAMA_NUM_PREDICT", "900");
  const input = request("ollama", { parameters: { max_output_tokens: { mode: "omit" } } });
  input.modelPolicy!.profiles!.local!.options = { num_predict: 500, top_k: 7 };
  expect(build(input)).not.toHaveProperty("options.num_predict");
  expect(build(input)).toHaveProperty("options.top_k", 7);
  input.modelPolicy!.profiles!.local!.generation = {};
  expect(build(input)).toHaveProperty("options.num_predict", 900);
});

test("explicit output overrides env while inherited recommendation preserves native precedence", () => {
  vi.stubEnv("OLLAMA_NUM_PREDICT", "900");
  expect(buildOllamaPayload(request("ollama", { parameters: { max_output_tokens: { mode: "value", value: 100 } } })))
    .toHaveProperty("options.num_predict", 100);
  expect(buildOllamaPayload(request("ollama", { parameters: { max_output_tokens: { mode: "inherit" } } })))
    .toHaveProperty("options.num_predict", 900);
});

test.each(["none", "xhigh"] as const)("stored %s is resolved from profile without changing saved config", (effort) => {
  const input = request("llamacpp", { reasoningEffort: effort }, true);
  const before = structuredClone(input);
  const payload = llama(input);
  if (effort === "none") {
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("chat_template_kwargs");
    expect(payload).not.toHaveProperty("reasoning_budget_tokens");
  } else expect(payload.reasoning_effort).toBe("high");
  expect(input).toEqual(before);
  expect(resolveModelInvocation(input).parameters?.warnings.length).toBeGreaterThan(0);
});

test("effort omission blocks automatic agent-mode effort but explicit request override wins", () => {
  const input = request("llamacpp", { parameters: { reasoning_effort: { mode: "omit" } } });
  expect(llama(input)).not.toHaveProperty("reasoning_effort");
  expect(llama({ ...input, reasoningOverride: "high" })).toHaveProperty("reasoning_effort", "high");
});

test("budget omit/value suppresses lower configured mode budgets", () => {
  const input = request("llamacpp", { reasoningEffort: "high", reasoningBudgetByMode: { deep: 0 },
    parameters: { thinking_budget: { mode: "omit" } } });
  expect(llama(input)).toHaveProperty("reasoning_effort", "high");
  expect(llama(input)).not.toHaveProperty("reasoning_budget_tokens");
  input.modelPolicy!.profiles!.local!.generation!.parameters!.thinking_budget = { mode: "value", value: 57 };
  expect(llama(input)).toHaveProperty("reasoning_budget_tokens", 57);
});

test("unsupported off cannot bypass constraints through budget zero, fast mode, raw or structured repair", () => {
  const input = request("llamacpp", { parameters: { thinking_budget: { mode: "value", value: 0 } } }, true);
  expect(llama(input)).not.toHaveProperty("reasoning_budget_tokens");
  expect(llama({ ...input, agentMode: "fast" })).not.toHaveProperty("reasoning_effort", "none");
  const ollama = request("ollama", { reasoningEffort: "high" }, true);
  expect(buildOllamaRawPayload(ollama)).toHaveProperty("think", "high");
  expect(buildOllamaPayload({ ...ollama, structuredOutputRepair: "json_schema_violation", format: { type: "object" } }))
    .toHaveProperty("think", "high");
});

test("actual calibration/model override chooses profile constraints, not the originally selected model", () => {
  const input = request("llamacpp", { reasoningEffort: "xhigh" });
  input.modelPolicy!.parameterProfiles = catalog;
  expect(llama(input)).toHaveProperty("reasoning_effort", "xhigh");
  expect(llama({ ...input, modelOverride: "gpt-oss:120b" })).toHaveProperty("reasoning_effort", "high");
  input.modelPolicy!.profiles!.other = { ...input.modelPolicy!.profiles!.local!, model: "gpt-oss:120b" };
  input.modelPolicy!.profiles!.local!.calibration = { target: { profileId: "other" } };
  input.modelPolicy!.defaults!.steps = { "execution.decision": "target" };
  expect(llama({ ...input, modelStep: "execution.decision" })).toHaveProperty("reasoning_effort", "high");
});

test("legacy custom provider reasoning survives without an advertised parameter manifest", () => {
  const input = request("custom", { reasoningEffort: "high" });
  expect(resolveModelInvocation(input).think).toBe("high");
  input.modelPolicy!.profiles!.local!.generation!.parameters = { top_k: { mode: "value", value: 4 } };
  expect(resolveModelInvocation(input).think).toBe("high");
  expect(resolveModelInvocation(input).parameters?.values).not.toHaveProperty("top_k");
});

test("model declared compatibility reaches OpenAI while unknown reasoning retains conservative sampling", () => {
  expect(buildOpenAIResponsesPayload(request("openai", { temperature: 1, reasoningEffort: "high" }))).not.toHaveProperty("temperature");
  expect(buildOpenAIResponsesPayload(request("openai", { temperature: 1, reasoningEffort: "high" }, true))).toHaveProperty("temperature", 1);
});

test("a matching capability profile does not auto-enable a legacy undeclared reasoning control", () => {
  const input = request("llamacpp", {}, true);
  input.modelPolicy!.profiles!.local!.supportsThinking = false;
  expect(llama(input)).not.toHaveProperty("reasoning_effort");
  input.modelPolicy!.profiles!.local!.generation = { parameters: { reasoning_effort: { mode: "value", value: "high" } } };
  expect(llama(input)).toHaveProperty("reasoning_effort", "high");
});

test("new Ollama raw effort controls are respected without changing legacy raw defaults", () => {
  expect(buildOllamaRawPayload(request("ollama", { reasoningEffort: "high" }))).toHaveProperty("think", false);
  expect(buildOllamaRawPayload(request("ollama", { parameters: { reasoning_effort: { mode: "value", value: "high" } } })))
    .toHaveProperty("think", "high");
  expect(buildOllamaRawPayload(request("ollama", { parameters: { reasoning_effort: { mode: "omit" } } })))
    .not.toHaveProperty("think");
});

test.each(["native", "environment"])("%s output override cannot bypass matched model constraints", (source) => {
  if (source === "environment") vi.stubEnv("OLLAMA_NUM_PREDICT", "500");
  for (const constraint of [{ supported: false }, { max: 100 }]) {
    const input = request("ollama", { parameters: { max_output_tokens: { mode: "inherit" } } }, true);
    if (source === "native") input.modelPolicy!.profiles!.local!.options = { num_predict: 500 };
    input.modelPolicy!.parameterProfiles = { ...catalog, profiles: [{ ...catalog.profiles[0],
      constraints: { ...catalog.profiles[0].constraints, max_output_tokens: constraint } }] };
    expect(resolveModelInvocation(input).parameters?.values).not.toHaveProperty("max_output_tokens");
    expect(buildOllamaPayload(input)).not.toHaveProperty("options.num_predict");
    expect(buildOllamaRawPayload(input)).not.toHaveProperty("options.num_predict");
  }
});
