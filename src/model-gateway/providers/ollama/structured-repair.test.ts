import { describe, expect, test } from "vitest";
import type { ModelGatewayPolicyConfig, ModelGatewayRequest } from "../../types.js";
import { buildOpenAIResponsesPayload } from "../openai/payload.js";
import { buildChatGptResponsesPayload } from "../openai-chatgpt/payload.js";
import { buildOllamaPayload, buildOllamaRawPayload } from "./payload.js";
import { projectOllamaThinkingDiagnostics } from "./structured-repair.js";

const FORMAT = {
  type: "json_schema" as const,
  name: "bounded_decision",
  schema: {
    type: "object",
    properties: { allowed: { type: "boolean" } },
    required: ["allowed"],
    additionalProperties: false,
  },
};
const POLICY: ModelGatewayPolicyConfig = {
  providers: { local: { type: "ollama" } },
  profiles: {
    fixture: {
      provider: "local", model: "fixture-model", contextWindowTokens: 32_768,
      supportsThinking: true, generation: { temperature: 0.7, topP: 0.8 },
    },
  },
  defaults: { profileId: "fixture" },
};
const REQUEST: ModelGatewayRequest = {
  agentMode: "deep",
  modelStep: "supervisor.decision",
  messages: [
    { role: "system", content: "Choose a permitted decision." },
    { role: "user", content: "Earlier request." },
    { role: "assistant", content: "Earlier settled reply." },
    { role: "user", content: "Current request." },
  ],
  format: FORMAT,
  modelPolicy: POLICY,
};

describe("Ollama structured repair projection", () => {
  test("changes only the existing marked attempt's thinking, preserving history, schema and preference", () => {
    const original = structuredClone(REQUEST);
    const first = buildOllamaPayload(REQUEST);
    const repaired = buildOllamaPayload({ ...REQUEST, structuredOutputRepair: "json_schema_violation" });
    expect(first.think).toBe("high");
    expect(repaired).toEqual({ ...first, think: false });
    expect(repaired).not.toHaveProperty("structuredOutputRepair");
    expect(REQUEST).toEqual(original);
    expect(buildOllamaPayload(REQUEST)).toEqual(first);
  });

  test.each([undefined, "json", { type: "text" }])(
    "does not override requests without a projected schema: %j", (format) => {
      const input = { ...REQUEST, format };
      expect(buildOllamaPayload({ ...input, structuredOutputRepair: "json_schema_violation" }))
        .toEqual(buildOllamaPayload(input));
    },
  );

  test.each([undefined, null, "semantic_rejection", {}, true])(
    "ignores an absent or malformed repair marker: %j", (marker) => {
      expect(buildOllamaPayload({
        ...REQUEST,
        structuredOutputRepair: marker as ModelGatewayRequest["structuredOutputRepair"],
      })).toEqual(buildOllamaPayload(REQUEST));
    },
  );

  test("does not enable thinking or invent support when it is disabled or unspecified", () => {
    const disabled = { ...REQUEST, agentMode: "fast" };
    expect(buildOllamaPayload({ ...disabled, structuredOutputRepair: "json_schema_violation" }))
      .toEqual(buildOllamaPayload(disabled));
    const unspecified = {
      ...REQUEST,
      modelPolicy: { ...POLICY, profiles: {
        fixture: { ...POLICY.profiles!.fixture!, supportsThinking: false },
      } },
    };
    const first = buildOllamaPayload(unspecified);
    expect(first).not.toHaveProperty("think");
    expect(buildOllamaPayload({ ...unspecified, structuredOutputRepair: "json_schema_violation" }))
      .toEqual(first);
  });

  test("leaves raw generation unchanged", () => {
    const request = { ...REQUEST, prompt: "Write the requested content." };
    expect(buildOllamaRawPayload({ ...request, structuredOutputRepair: "json_schema_violation" }))
      .toEqual(buildOllamaRawPayload(request));
  });

  test.each([
    ["openai", buildOpenAIResponsesPayload],
    ["openai-chatgpt", buildChatGptResponsesPayload],
  ] as const)("leaves %s provider generation unchanged", (provider, build) => {
    const request = { ...REQUEST, modelPolicy: {
      ...POLICY, providers: { local: { type: provider } },
    } };
    expect(build({ ...request, structuredOutputRepair: "json_schema_violation" }))
      .toEqual(build(request));
  });

  test("diagnoses the requested/effective mode and only the actual compatibility override", () => {
    const context = {
      endpoint: "chat" as const, requestedThinking: "high" as const,
      effectiveThinking: false, structuredOutputRepair: "json_schema_violation",
      projectedFormat: FORMAT.schema,
    };
    expect(projectOllamaThinkingDiagnostics(context)).toEqual({
      requestedThinking: "high", effectiveThinking: false,
      thinkingOverrideReason: "structured_output_schema_repair",
    });
    for (const input of [
      { ...context, endpoint: "raw" as const },
      { ...context, structuredOutputRepair: undefined },
      { ...context, effectiveThinking: "high" },
      { ...context, projectedFormat: undefined },
    ]) {
      expect(projectOllamaThinkingDiagnostics(input)).not.toHaveProperty("thinkingOverrideReason");
    }
  });
});
