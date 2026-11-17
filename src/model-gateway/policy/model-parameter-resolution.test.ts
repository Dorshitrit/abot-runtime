import { afterEach, expect, test, vi } from "vitest";
import type { ModelParameterProfile, ModelParameterProfileCatalog } from "../../shared/model-parameters.js";
import { resolveModelParameterPresentation, resolveModelParameters } from "./model-parameter-resolution.js";

const profile: ModelParameterProfile = { schemaVersion: 1, id: "fixture", match: [{ kind: "exact", pattern: "model" }],
  defaults: { temperature: 1, top_p: 1, top_k: 0 }, reasoning: { efforts: ["low", "medium", "high"],
    mappings: { minimal: "low", xhigh: "high", none: null }, canDisableThinking: false } };
const catalog: ModelParameterProfileCatalog = { schemaVersion: 1, revision: "fixture", profiles: [profile], diagnostics: [] };
const base = { provider: "llamacpp", model: "model", catalog, supportsThinking: true };
afterEach(() => vi.unstubAllEnvs());

test("absent is legacy, inherit uses recommendation, omit never fills, explicit zero survives", () => {
  const result = resolveModelParameters({ ...base, generation: { parameters: {
    top_p: { mode: "inherit" }, temperature: { mode: "omit" }, top_k: { mode: "value", value: 0 },
  } } });
  expect(result.values).toEqual({ top_p: 1, top_k: 0 });
  expect(resolveModelParameters(base).values).toEqual({});
});

test.each([["minimal", "low"], ["xhigh", "high"], ["none", undefined]] as const)("maps %s without rewriting config", (effort, expected) => {
  const generation = { reasoningEffort: effort };
  expect(resolveModelParameters({ ...base, generation }).values.reasoning_effort).toBe(expected);
  expect(generation.reasoningEffort).toBe(effort);
});

test("unknown model exposes transport controls with unknown model support and no none option", () => {
  const result = resolveModelParameterPresentation({ provider: "llamacpp", model: "unknown", supportsThinking: true });
  expect(result.parameters.find((field) => field.key === "top_k")).toMatchObject({ supported: true, modelSupport: "unknown" });
  expect(result.parameters.find((field) => field.key === "reasoning_effort")?.values).not.toContain("none");
  expect(resolveModelParameters({ provider: "llamacpp", model: "unknown", supportsThinking: true,
    generation: { parameters: { reasoning_effort: { mode: "value", value: "none" } } } }).values).not.toHaveProperty("reasoning_effort");
});

test("provider and model ranges intersect while unsupported controls stay omitted", () => {
  const result = resolveModelParameters({ provider: "openai", model: "unknown", generation: { parameters: {
    top_k: { mode: "value", value: 8 }, temperature: { mode: "value", value: 3 },
  } } });
  expect(result.values).toEqual({});
  expect(result.warnings).toHaveLength(2);
});

test("provider compatibility is visible and a model can replace only that conditional rule", () => {
  const generation = { temperature: 1, reasoningEffort: "high" as const };
  const ordinary = resolveModelParameters({ provider: "openai", model: "unknown", generation, supportsThinking: true });
  expect(ordinary.values).not.toHaveProperty("temperature");
  const compatible = { ...profile, constraints: { temperature: { requires: { key: "reasoning_effort" as const, values: ["high"] } } } };
  const result = resolveModelParameters({ provider: "openai", model: "model", generation, catalog: { ...catalog, profiles: [compatible] } });
  expect(result.values.temperature).toBe(1);
});

test("native saved values and environment override have truthful provenance", () => {
  vi.stubEnv("OLLAMA_NUM_PREDICT", "640");
  const result = resolveModelParameterPresentation({ provider: "ollama", model: "unknown", options: { temperature: 0.7, num_predict: 32 },
    generation: { parameters: { max_output_tokens: { mode: "inherit" } } } });
  expect(result.parameters.find((field) => field.key === "max_output_tokens")).toMatchObject({ value: 640, source: "provider" });
  expect(result.parameters.find((field) => field.key === "temperature")).toMatchObject({ value: 0.7, source: "configuration" });
});

test("conditional removals reach a fixed point independent of declaration order", () => {
  const conditional: ModelParameterProfile = { ...profile, constraints: {
    top_p: { requires: { key: "top_k", values: [5] } }, top_k: { requires: { key: "seed", values: [42] } },
  } };
  const result = resolveModelParameters({ ...base, catalog: { ...catalog, profiles: [conditional] }, generation: { parameters: {
    top_p: { mode: "value", value: 0.9 }, top_k: { mode: "value", value: 5 }, seed: { mode: "value", value: 0 },
  } } });
  expect(result.values).toEqual({ seed: 0 });
  expect(result.fields.top_p?.warnings).toHaveLength(1);
  expect(result.fields.top_k?.warnings).toHaveLength(1);
});

test("presentation intersects generic, transport and model bounds", () => {
  const constrained: ModelParameterProfile = { ...profile, constraints: { temperature: { min: 0.5, max: 5 } } };
  const result = resolveModelParameterPresentation({ provider: "openai", model: "model", catalog: { ...catalog, profiles: [constrained] } });
  expect(result.parameters.find((field) => field.key === "temperature")).toMatchObject({ min: 0.5, max: 2 });
});

test("native output sentinels retain their existing adapter meaning", () => {
  vi.stubEnv("OLLAMA_NUM_PREDICT", "");
  const result = resolveModelParameters({ provider: "ollama", model: "unknown", options: { num_predict: -1 },
    generation: { parameters: { max_output_tokens: { mode: "inherit" } } } });
  expect(result.values.max_output_tokens).toBe(-1);
  expect(result.fields.max_output_tokens?.warnings).toEqual([]);
});

test("unusable provider recommendations never become Apply recommended input", () => {
  const incompatible: ModelParameterProfile = { ...profile, defaults: { temperature: 3, top_k: 8, reasoning_effort: "xhigh" } };
  const result = resolveModelParameterPresentation({ provider: "openai", model: "model", supportsThinking: true,
    catalog: { ...catalog, profiles: [incompatible] } });
  expect(result.parameters.find((field) => field.key === "temperature")).not.toHaveProperty("recommended");
  expect(result.parameters.find((field) => field.key === "top_k")).not.toHaveProperty("recommended");
  expect(result.parameters.find((field) => field.key === "reasoning_effort")).toHaveProperty("recommended", "high");
});

test("recommended values are validated together through dependency chains", () => {
  const incompatible: ModelParameterProfile = { ...profile, defaults: { top_p: 0.9, top_k: 5, seed: 0 }, constraints: {
    top_p: { requires: { key: "top_k", values: [5] } }, top_k: { requires: { key: "seed", values: [42] } },
  } };
  const result = resolveModelParameterPresentation({ ...base, catalog: { ...catalog, profiles: [incompatible] } });
  expect(result.parameters.find((field) => field.key === "top_p")).not.toHaveProperty("recommended");
  expect(result.parameters.find((field) => field.key === "top_k")).not.toHaveProperty("recommended");
  expect(result.parameters.find((field) => field.key === "seed")).toHaveProperty("recommended", 0);
});
