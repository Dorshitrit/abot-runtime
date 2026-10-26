import { expect, test } from "vitest";
import { resolveModelInvocation } from "../invocation-policy.js";
import { buildOllamaPayload } from "../providers/ollama/payload.js";
import { buildOpenAIInputTokenCountPayload, buildOpenAIResponsesPayload } from "../providers/openai/payload.js";
import type { ModelGatewayRequest, ModelGatewayJsonSchemaFormat } from "../types.js";

const format: ModelGatewayJsonSchemaFormat = {
  type: "json_schema",
  name: "checkpoint",
  strict: true,
  calibrationInstructions: "omit",
  schema: {
    type: "object",
    properties: { digest: { type: "string" } },
    required: ["digest"],
    additionalProperties: false,
  },
};

function compactionRequest(provider: "openai" | "ollama"): ModelGatewayRequest {
  return {
    agentMode: "reasoning",
    modelStep: "context.compact",
    format,
    messages: [{ role: "system", content: "minimal-owned-contract" }],
    modelPolicy: {
      providers: { fixture: { type: provider } },
      profiles: {
        fixture: {
          provider: "fixture",
          model: "fixture-model",
          contextWindowTokens: 32000,
          calibration: {
            "context.compact": { instructions: ["CALIBRATION_ONLY"], generation: { temperature: 0.25 } },
          },
        },
      },
      defaults: { profileId: "fixture", steps: { "context.compact": "context.compact", "worker.decision": "context.compact" } },
    },
  };
}

test.each(["openai", "ollama"] as const)("%s omits only explicitly isolated compaction calibration for count and send", (provider) => {
  const input = compactionRequest(provider);
  const original = structuredClone(input);
  const invocation = resolveModelInvocation(input);
  expect(invocation.instructions).toBeUndefined();
  expect(invocation.profile.generation.temperature).toBe(0.25);
  expect(invocation.model).toBe("fixture-model");
  const builders = provider === "openai"
    ? [buildOpenAIInputTokenCountPayload, buildOpenAIResponsesPayload]
    : [buildOllamaPayload];
  for (const build of builders) {
    const payload = build(input);
    expect(JSON.stringify(payload)).not.toContain("CALIBRATION_ONLY");
    expect(JSON.stringify(payload)).not.toContain("calibrationInstructions");
    expect(JSON.stringify(payload)).toContain("digest");
    for (const ordinary of [
      { ...input, format: { ...format, calibrationInstructions: undefined } },
      { ...input, modelStep: "worker.decision" },
      { ...input, format: "json" },
    ]) expect(JSON.stringify(build(ordinary))).toContain("CALIBRATION_ONLY");
  }
  expect(input).toEqual(original);
});
