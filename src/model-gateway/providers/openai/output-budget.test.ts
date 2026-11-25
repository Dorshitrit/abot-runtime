import { expect, test } from "vitest";
import type { ModelParameterProfile } from "../../../shared/model-parameters.js";
import { ModelProviderContextWindowExceededError } from "../../observability/context-window-guard.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayRequest } from "../../types.js";
import { createProviderEnvelopeFingerprint, estimateProviderEnvelopeInputTokens } from "../envelope-budget.js";
import { applyOpenAIComputedOutputBudget } from "./output-budget.js";
import { buildOpenAIResponsesPayload } from "./payload.js";

function request(model = "gpt-6-luna"): ModelGatewayRequest {
  return { modelStep: "execution.decision", agentMode: "deep", messages: [{ role: "user", content: "Write the complete artifact." }],
    modelPolicy: { providers: { remote: { type: "openai" } }, outputSafetyReserveTokens: 1200,
      profiles: { selected: { provider: "remote", model, contextWindowTokens: 1_050_000, supportsThinking: true } },
      defaults: { profileId: "selected" } } };
}

function setParameterProfile(req: ModelGatewayRequest, patch: Partial<ModelParameterProfile>) {
  req.modelPolicy!.parameterProfiles = { schemaVersion: 1, revision: "test", diagnostics: [], profiles: [
    { schemaVersion: 1, id: "custom", match: [{ kind: "exact", provider: "openai", pattern: req.modelPolicy!.profiles!.selected!.model! }], ...patch },
  ] };
}

function apply(req: ModelGatewayRequest, inputTokens?: number) {
  const payload = buildOpenAIResponsesPayload(req);
  const invocation = resolveModelInvocation(req);
  const parameters = applyOpenAIComputedOutputBudget({ requestBody: req, invocation, endpoint: "chat", fetchImpl: fetch,
    ...(inputTokens === undefined ? {} : { inputTokenMeasurement: { inputTokens, source: "provider_input_token_count" as const,
      providerEnvelopeFingerprint: createProviderEnvelopeFingerprint(payload) } }) }, payload);
  return { payload, parameters, invocation };
}

test("legacy Luna gets its declared ceiling without changing effective reasoning or sampling", () => {
  const req = request();
  req.modelPolicy!.profiles!.selected!.generation = { temperature: 0.3, topP: 0.9 };
  const before = buildOpenAIResponsesPayload(req);
  const result = apply(req, 3075);
  expect(result.invocation.parameters).toBeUndefined();
  expect(result.payload).toEqual({ ...before, max_output_tokens: 128000 });
  expect(result.parameters?.fields.max_output_tokens).toMatchObject({ value: 128000, source: "provider", omitted: false });
});

test("context remainder subtracts the measured envelope and request-frozen safety reserve", () => {
  const req = request();
  req.modelPolicy!.profiles!.selected!.contextWindowTokens = 32000;
  expect(apply(req, 3075).payload.max_output_tokens).toBe(27725);
  delete req.modelPolicy!.outputSafetyReserveTokens;
  expect(apply(req, 3075).payload.max_output_tokens).toBe(28925);
});

test.each([16, 15, 0, -1])("remaining allowance %s respects the provider minimum without overdraw", (remaining) => {
  const req = request();
  req.modelPolicy!.profiles!.selected!.contextWindowTokens = 32000;
  const run = () => apply(req, 32000 - 1200 - remaining);
  if (remaining === 16) expect(run().payload.max_output_tokens).toBe(16);
  else expect(run).toThrow(ModelProviderContextWindowExceededError);
});

test("a narrower declared model limit wins and an oversized profile cannot exceed the provider ceiling", () => {
  const req = request();
  setParameterProfile(req, { constraints: { max_output_tokens: { max: 64000 } } });
  expect(apply(req, 100).payload.max_output_tokens).toBe(64000);
  setParameterProfile(req, { constraints: { max_output_tokens: { max: 999999 } } });
  expect(apply(req, 100).payload.max_output_tokens).toBe(128000);
});

test("an explicitly declared ceiling enables computation for another model", () => {
  const req = request("custom-openai-model");
  setParameterProfile(req, { constraints: { max_output_tokens: { max: 24000 } } });
  expect(apply(req, 100).payload.max_output_tokens).toBe(24000);
});

test("unsupported output controls are never filled", () => {
  const req = request();
  setParameterProfile(req, { constraints: { max_output_tokens: { supported: false, max: 64000 } } });
  expect(apply(req, 100).payload).not.toHaveProperty("max_output_tokens");
});

test.each([4000, 0])("inherit preserves recommendation %s and its existing validation outcome", (value) => {
  const req = request();
  req.modelPolicy!.profiles!.selected!.generation = { parameters: { max_output_tokens: { mode: "inherit" } } };
  setParameterProfile(req, { defaults: { max_output_tokens: value } });
  const before = buildOpenAIResponsesPayload(req);
  expect(apply(req, 100).payload).toEqual(before);
});

test.each(["value", "omit"] as const)("per-step %s survives the late default", (mode) => {
  const req = request();
  req.modelPolicy!.profiles!.selected!.calibration = { "execution.decision": { generation: {
    parameters: { max_output_tokens: mode === "value" ? { mode, value: 4096 } : { mode } },
  } } };
  req.modelPolicy!.defaults!.steps = { "execution.decision": "execution.decision" };
  const before = buildOpenAIResponsesPayload(req);
  expect(apply(req, 1_050_000).payload).toEqual(before);
  if (mode === "value") expect(before.max_output_tokens).toBe(4096);
  else expect(before).not.toHaveProperty("max_output_tokens");
});

test("late computation preserves a rejected reasoning control and its diagnostics", () => {
  const req = request();
  req.modelPolicy!.profiles!.selected!.generation = { parameters: {
    reasoning_effort: { mode: "value", value: "none" }, temperature: { mode: "value", value: 0.4 },
  } };
  setParameterProfile(req, { reasoning: { efforts: ["medium", "high"], canDisableThinking: false } });
  const before = buildOpenAIResponsesPayload(req);
  const result = apply(req, 100);
  expect(result.payload).toEqual({ ...before, max_output_tokens: 128000 });
  expect(result.parameters?.fields.reasoning_effort).toEqual(result.invocation.parameters?.fields.reasoning_effort);
  expect(result.parameters?.warnings).toEqual(expect.arrayContaining([...result.invocation.parameters!.warnings]));
});

test("the complete projected envelope drives fallback estimation without rewriting the request", () => {
  const req = request();
  req.modelPolicy!.profiles!.selected!.contextWindowTokens = 32000;
  req.messages = [{ role: "system", content: "Instructions.".repeat(100) }, { role: "user", content: "Write the artifact." }];
  req.format = { type: "object", properties: { content: { type: "string", description: "Required content.".repeat(100) } }, required: ["content"] };
  const original = JSON.stringify(req);
  const result = apply(req);
  expect(result.payload.max_output_tokens).toBe(32000 - 1200 - estimateProviderEnvelopeInputTokens(result.payload, result.invocation.profile.context.tokenEstimation));
  expect(JSON.stringify(req)).toBe(original);
});

test("a computed cap cannot depend on a control that was already omitted", () => {
  const req = request();
  req.modelPolicy!.profiles!.selected!.generation = { parameters: { temperature: { mode: "value", value: 0.4 } } };
  setParameterProfile(req, { constraints: {
    temperature: { requires: { key: "max_output_tokens", values: [128000] } },
    max_output_tokens: { requires: { key: "temperature", values: [0.4] } },
  } });
  const result = apply(req, 100);
  expect(result.payload).not.toHaveProperty("temperature");
  expect(result.payload).not.toHaveProperty("max_output_tokens");
  expect(result.parameters?.fields.max_output_tokens?.warnings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "model_parameter_requirement_unsatisfied" }),
  ]));
});

test("a computed cap cannot invalidate a retained user control", () => {
  const req = request();
  req.modelPolicy!.profiles!.selected!.generation = { parameters: { temperature: { mode: "value", value: 0.4 } } };
  setParameterProfile(req, { constraints: {
    temperature: { requires: { key: "max_output_tokens", values: [64000], allowMissing: true } },
  } });
  const before = buildOpenAIResponsesPayload(req);
  expect(before.temperature).toBe(0.4);
  const result = apply(req, 100);
  expect(result.payload).toEqual(before);
  expect(result.parameters?.fields.temperature).toEqual(result.invocation.parameters?.fields.temperature);
  expect(result.parameters?.fields.max_output_tokens?.warnings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "model_parameter_requirement_unsatisfied", key: "max_output_tokens" }),
  ]));
});
