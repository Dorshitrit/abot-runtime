import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { buildModelConfig } from "../../../../scripts/runtime-setup-files.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayProfileConfig, ModelGatewayRequest } from "../../types.js";
import { createProviderEnvelopeFingerprint } from "../envelope-budget.js";
import { buildOpenAIInputTokenCountPayload, buildOpenAIResponsesPayload } from "./payload.js";

function decisionRequest(): ModelGatewayRequest {
  return {
    modelStep: "execution.decision",
    agentMode: "deep",
    messages: [{ role: "user", content: "Choose the next action for the existing draft." }],
    modelPolicy: {
      providers: { remote: { type: "openai" } },
      profiles: {
        reasoning: {
          provider: "remote", model: "test-reasoning-model",
          contextWindowTokens: 120_000, supportsThinking: true,
        },
      },
      defaults: { profileId: "reasoning" },
    },
  };
}

function measuredPayload(request: ModelGatewayRequest, inputTokens: number) {
  const countPayload = buildOpenAIInputTokenCountPayload(request);
  return buildOpenAIResponsesPayload(request, {
    inputTokenMeasurement: {
      inputTokens,
      providerEnvelopeFingerprint: createProviderEnvelopeFingerprint(countPayload),
      source: "provider_input_token_count",
    },
  });
}

describe("OpenAI core decision output budget", () => {
  test("does not spend the visible decision limit on high reasoning before any answer", () => {
    const request = decisionRequest();
    const invocation = resolveModelInvocation(request);
    expect(invocation).toMatchObject({
      think: "high", profile: { supportsThinking: true, contextWindowTokens: 120_000 },
    });
    const payload = measuredPayload(request, 25_610);
    expect(payload.reasoning).toEqual({ effort: "high" });
    expect(payload).not.toHaveProperty("max_output_tokens");
  });

  test("retains the core limit when fast mode explicitly disables reasoning", () => {
    const request = { ...decisionRequest(), agentMode: "fast" };
    expect(resolveModelInvocation(request).think).toBe("none");
    expect(buildOpenAIResponsesPayload(request)).toMatchObject({
      reasoning: { effort: "none" }, max_output_tokens: 2_048,
    });
  });

  test.each([false, undefined])("leaves provider-default reasoning room with supportsThinking=%s", (supportsThinking) => {
    const request = decisionRequest();
    request.modelPolicy!.profiles!.reasoning!.supportsThinking = supportsThinking;
    for (const preference of [{ agentMode: "deep" }, { agentMode: "fast" }, { reasoningOverride: "none" as const }]) {
      const invocation = resolveModelInvocation({ ...request, ...preference });
      expect(invocation.profile.supportsThinking).toBe(false);
      expect(invocation.think).toBeUndefined();
      const payload = buildOpenAIResponsesPayload({ ...request, ...preference });
      expect(payload).not.toHaveProperty("reasoning");
      expect(payload).not.toHaveProperty("max_output_tokens");
    }
  });

  test("keeps a newly scaffolded OpenAI profile safe without a thinking declaration", async () => {
    const template = JSON.parse(await readFile("examples/models/default.config.json", "utf8"));
    const freshProfile = buildModelConfig(template, "openai", "new-model");
    expect(freshProfile).not.toHaveProperty("supportsThinking");
    const request = decisionRequest();
    request.modelPolicy!.profiles!.reasoning = { ...freshProfile, provider: "remote" } as ModelGatewayProfileConfig;
    expect(resolveModelInvocation(request).profile.supportsThinking).toBe(false);
    const payload = buildOpenAIResponsesPayload(request);
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("max_output_tokens");
  });

  test.each([
    "supervisor.decision", "planner.decision", "worker.decision",
    "reviewer.decision", "execution.decision", "auditor.decision",
  ])("budgets the %s step from projected reasoning rather than the role", (modelStep) => {
    const request = { ...decisionRequest(), modelStep };
    expect(buildOpenAIResponsesPayload(request)).not.toHaveProperty("max_output_tokens");
    expect(buildOpenAIResponsesPayload({ ...request, agentMode: "fast" })).toMatchObject({
      reasoning: { effort: "none" }, max_output_tokens: 2_048,
    });
    delete request.modelPolicy!.profiles!.reasoning!.supportsThinking;
    expect(buildOpenAIResponsesPayload({ ...request, agentMode: "fast" })).not.toHaveProperty("max_output_tokens");
  });

  test.each([false, undefined])("preserves explicit sampling without declared reasoning controls (%s)", (supportsThinking) => {
    const request = decisionRequest();
    request.modelPolicy!.profiles!.reasoning!.supportsThinking = supportsThinking;
    request.modelPolicy!.profiles!.reasoning!.generation = { temperature: 0.2, topP: 0.9 };
    const payload = buildOpenAIResponsesPayload(request);
    expect(payload).toMatchObject({ temperature: 0.2, top_p: 0.9 });
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("max_output_tokens");
  });

  test.each([
    ["deep", "none", 2_048],
    ["fast", "high", undefined],
  ] as const)("honors the explicit %s override %s", (agentMode, reasoningOverride, expectedLimit) => {
    const request = { ...decisionRequest(), agentMode, reasoningOverride };
    expect(resolveModelInvocation(request).think).toBe(reasoningOverride);
    const payload = buildOpenAIResponsesPayload(request);
    expect(payload.reasoning).toEqual({ effort: reasoningOverride });
    expect(payload.max_output_tokens).toBe(expectedLimit);
  });

  test("respects per-step reasoning calibration without changing the shared core limit", () => {
    const request = decisionRequest();
    request.modelPolicy!.profiles!.reasoning!.calibration = {
      "execution.decision": { generation: { reasoningEffort: "none" } },
    };
    request.modelPolicy!.defaults!.steps = { "execution.decision": "execution.decision" };
    expect(resolveModelInvocation(request).think).toBe("none");
    expect(buildOpenAIResponsesPayload(request).max_output_tokens).toBe(2_048);
  });

  test("does not cap the default reasoning mode when no effort was configured", () => {
    const request = decisionRequest();
    delete request.agentMode;
    expect(resolveModelInvocation(request).think).toBe("medium");
    expect(buildOpenAIResponsesPayload(request)).not.toHaveProperty("max_output_tokens");
  });

  test.each(["unregistered.decision", "execution.response"])(
    "leaves the non-core %s step unchanged", (modelStep) => {
      const request = { ...decisionRequest(), modelStep, agentMode: "fast" };
      expect(buildOpenAIResponsesPayload(request)).not.toHaveProperty("max_output_tokens");
    },
  );

  test("keeps the physical headroom clamp when reasoning is disabled", () => {
    const request = { ...decisionRequest(), agentMode: "fast" };
    expect(measuredPayload(request, 119_900).max_output_tokens).toBe(100);
    expect(measuredPayload(request, 119_999).max_output_tokens).toBe(1);
  });

  test.each([
    ["deep", true], ["fast", true], ["deep", false], ["fast", undefined],
  ] as const)("preserves the input-count envelope for %s mode with controls=%s", (agentMode, supportsThinking) => {
    const request = { ...decisionRequest(), agentMode };
    request.modelPolicy!.profiles!.reasoning!.supportsThinking = supportsThinking;
    const payload = buildOpenAIResponsesPayload(request);
    const expected = { ...payload };
    for (const key of ["stream", "temperature", "top_p", "max_output_tokens"]) delete expected[key];
    const counted = buildOpenAIInputTokenCountPayload(request);
    expect(counted).toEqual(expected);
    expect(counted.input).toEqual(request.messages);
    expect(counted).not.toHaveProperty("max_output_tokens");
    expect(createProviderEnvelopeFingerprint(counted)).toBe(
      createProviderEnvelopeFingerprint(expected),
    );
  });
});
