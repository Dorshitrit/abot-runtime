import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelParameterConstraint, ResolvedModelParameters } from "../../../shared/model-parameters.js";
import type { ModelGatewayRequest } from "../../types.js";
import { buildOllamaPayload, buildOllamaRawPayload } from "./payload.js";

beforeEach(() => vi.stubEnv("OLLAMA_NUM_PREDICT", ""));
afterEach(() => vi.unstubAllEnvs());

function request(constraint?: ModelParameterConstraint): ModelGatewayRequest {
  return { text: "hello", modelPolicy: {
    providers: { local: { type: "ollama" } }, profiles: { local: { provider: "local", model: "fixture", contextWindowTokens: 4096 } },
    defaults: { profileId: "local" }, ...(constraint ? { parameterProfiles: { schemaVersion: 1 as const, revision: "fixture", diagnostics: [],
      profiles: [{ schemaVersion: 1 as const, id: "fixture", match: [{ kind: "exact" as const, pattern: "fixture" }],
        constraints: { max_output_tokens: constraint } }] } } : {}),
  } };
}

test.each(["chat", "raw"])("late %s allowance is constrained and diagnosed after input projection", (endpoint) => {
  const build = endpoint === "chat" ? buildOllamaPayload : buildOllamaRawPayload;
  for (const constraint of [{ max: 100 }, { requires: { key: "seed" as const, values: [42] } }]) {
    const input = request(constraint);
    const before = structuredClone(input);
    let resolution: ResolvedModelParameters | undefined;
    const payload = build(input, { onParameterResolution(result) { resolution = result; } });
    expect(payload).not.toHaveProperty("options.num_predict");
    expect(resolution?.fields.max_output_tokens).toMatchObject({ omitted: true, source: "provider" });
    expect(resolution?.fields.max_output_tokens?.warnings).toHaveLength(1);
    expect(resolution?.warnings.some((warning) => warning.key === "max_output_tokens")).toBe(true);
    expect(input).toEqual(before);
  }
});

test.each(["chat", "raw"])("valid late %s allowance and its diagnostics equal the legacy wire cap", (endpoint) => {
  const build = endpoint === "chat" ? buildOllamaPayload : buildOllamaRawPayload;
  const legacy = build(request());
  let resolution: ResolvedModelParameters | undefined;
  const payload = build(request({ max: 4096 }), { onParameterResolution(result) { resolution = result; } });
  expect(payload).toEqual(legacy);
  expect(resolution?.values.max_output_tokens).toBe((payload.options as Record<string, unknown>).num_predict);
  expect(resolution?.fields.max_output_tokens?.warnings).toEqual([]);
});

test("satisfied dependency preserves calculated output and recommendation still outranks computed default", () => {
  const input = request({ requires: { key: "seed", values: [42] } });
  input.modelPolicy!.profiles!.local!.generation = { parameters: { seed: { mode: "value", value: 42 } } };
  expect(buildOllamaPayload(input)).toHaveProperty("options.num_predict", expect.any(Number));
  const catalog = input.modelPolicy!.parameterProfiles!;
  input.modelPolicy!.parameterProfiles = { ...catalog, profiles: [{ ...catalog.profiles[0], defaults: { max_output_tokens: 80 } }] };
  input.modelPolicy!.profiles!.local!.generation!.parameters!.max_output_tokens = { mode: "inherit" };
  expect(buildOllamaPayload(input)).toHaveProperty("options.num_predict", 80);
});

test.each(["chat", "raw"])("late %s allowance also removes reasoning whose dependency is no longer satisfied", (endpoint) => {
  const build = endpoint === "chat" ? buildOllamaPayload : buildOllamaRawPayload;
  const input = request({ max: 4096 });
  input.modelPolicy!.profiles!.local!.generation = { parameters: { reasoning_effort: { mode: "value", value: "high" } } };
  const catalog = input.modelPolicy!.parameterProfiles!;
  input.modelPolicy!.parameterProfiles = { ...catalog, profiles: [{ ...catalog.profiles[0],
    reasoning: { efforts: ["low", "medium", "high"], canDisableThinking: false },
    constraints: { reasoning_effort: { requires: { key: "max_output_tokens", values: [16], allowMissing: true } } },
  }] };
  let resolution: ResolvedModelParameters | undefined;
  const payload = build(input, { onParameterResolution(result) { resolution = result; } });
  expect(payload).not.toHaveProperty("think");
  expect(resolution?.fields.reasoning_effort).toMatchObject({ omitted: true });
  expect(resolution?.fields.reasoning_effort?.warnings).toHaveLength(1);
  expect(payload).toHaveProperty("options.num_predict", expect.any(Number));
  input.modelPolicy!.profiles!.local!.generation!.parameters!.max_output_tokens = { mode: "value", value: 16 };
  expect(build(input)).toHaveProperty("think", "high");
});
