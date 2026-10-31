import { describe, expect, test } from "vitest";
import { assessRequestMessagesBudget } from "../../runtime/context/request-context-budget.js";
import { estimateMessagesTokens, estimateTextTokens } from "../../runtime/context/token-estimator.js";
import { assertFinalProviderEnvelopeFits } from "../observability/context-window-guard.js";
import { createProviderTraceContext } from "../observability/provider-trace-context.js";
import { resolveProviderEnvelopeInputTokens } from "../providers/envelope-budget.js";
import type { ModelGatewayPolicyConfig, ModelGatewayRequest } from "../types.js";
import { resolveModelInvocation } from "./invocation-policy.js";
import { getModelProfile, resolveModelContextConfig } from "./model-registry.js";

const CHATGPT_ESTIMATION = {
  asciiCharactersPerToken: 4,
  nonAsciiBytesPerToken: 2,
  messageOverheadTokens: 6,
};

function policyFor(provider = "openai-chatgpt"): ModelGatewayPolicyConfig {
  return {
    providers: { selected: { type: provider } },
    profiles: {
      selected: { provider: "selected", model: "fixture-model", contextWindowTokens: 32_768 },
    },
    defaults: { profileId: "selected" },
  };
}

function requestFor(modelPolicy: ModelGatewayPolicyConfig): ModelGatewayRequest {
  return { modelStep: "execution.decision", modelPolicy };
}

function contextFor(modelPolicy: ModelGatewayPolicyConfig) {
  return resolveModelInvocation(requestFor(modelPolicy)).profile.context;
}

describe("provider-owned token estimation defaults", () => {
  test("binds ChatGPT estimates to provider identity without changing capacity", () => {
    const policy = policyFor();
    const profile = getModelProfile("selected", policy)!;
    expect(profile.context.tokenEstimation).toEqual(CHATGPT_ESTIMATION);
    expect(profile.contextWindowTokens).toBe(32_768);
    expect(contextFor(policy).tokenEstimation).toEqual(CHATGPT_ESTIMATION);
    expect(resolveModelContextConfig({ modelPolicy: policy }).tokenEstimation)
      .toEqual(CHATGPT_ESTIMATION);
    expect(policy.profiles!.selected!.context).toBeUndefined();
    expect(policy.defaults!.context).toBeUndefined();
  });

  test.each(["ollama", "llamacpp", "openai", "custom-provider"])(
    "preserves %s estimates even for a ChatGPT-looking model name", (provider) => {
      const policy = policyFor(provider);
      policy.profiles!.selected!.model = "gpt-6-sol";
      const context = contextFor(policy);
      expect(context.tokenEstimation).toBeUndefined();
      expect(estimateTextTokens("x".repeat(80), context.tokenEstimation)).toBe(40);
    },
  );

  test("retains the existing non-ASCII and message-overhead charges", () => {
    const estimation = contextFor(policyFor()).tokenEstimation;
    expect(estimateTextTokens("x".repeat(80), estimation)).toBe(20);
    expect(estimateTextTokens("שלום", estimation)).toBe(estimateTextTokens("שלום"));
    expect(estimateMessagesTokens([{ role: "user", content: "" }], estimation)).toBe(6);
  });

  test("preserves all explicit global estimate settings", () => {
    const policy = policyFor();
    const configured = {
      asciiCharactersPerToken: 3,
      nonAsciiBytesPerToken: 1.5,
      messageOverheadTokens: 12,
    };
    policy.defaults!.context = { tokenEstimation: configured };
    expect(contextFor(policy).tokenEstimation).toEqual(configured);
    expect(policy.defaults!.context.tokenEstimation).toEqual(configured);
  });

  test("preserves shallow profile precedence and defaults only missing fields", () => {
    const policy = policyFor();
    policy.defaults!.context = {
      tokenEstimation: { asciiCharactersPerToken: 3, nonAsciiBytesPerToken: 1 },
    };
    policy.profiles!.selected!.context = {
      tokenEstimation: { asciiCharactersPerToken: 5 },
      formatTokenAccounting: { mode: "none" },
    };
    expect(contextFor(policy)).toEqual({
      tokenEstimation: { ...CHATGPT_ESTIMATION, asciiCharactersPerToken: 5 },
      formatTokenAccounting: { mode: "none" },
    });
  });

  test("fills partial invocation overrides after their shallow overlay", () => {
    const policy = policyFor();
    policy.profiles!.selected!.context = { tokenEstimation: { asciiCharactersPerToken: 5 } };
    policy.invocationProfiles = {
      decision: { profileId: "selected", context: { tokenEstimation: { messageOverheadTokens: 9 } } },
    };
    policy.defaults!.steps = { "execution.decision": "decision" };
    expect(contextFor(policy).tokenEstimation).toEqual({
      ...CHATGPT_ESTIMATION, messageOverheadTokens: 9,
    });
  });

  test("preserves explicit calibration overrides and fills their omitted fields", () => {
    const policy = policyFor();
    policy.profiles!.selected!.calibration = {
      decision: { context: { tokenEstimation: { asciiCharactersPerToken: 2.5 } } },
    };
    policy.defaults!.steps = { "execution.decision": "decision" };
    expect(contextFor(policy).tokenEstimation).toEqual({
      ...CHATGPT_ESTIMATION, asciiCharactersPerToken: 2.5,
    });
  });

  test("uses the calibrated target provider's defaults", () => {
    const policy = policyFor();
    policy.providers!.local = { type: "ollama" };
    policy.profiles!.local = { provider: "local", model: "fixture", contextWindowTokens: 16_384 };
    policy.profiles!.selected!.calibration = { decision: { profileId: "local" } };
    policy.defaults!.steps = { "execution.decision": "decision" };
    const invocation = resolveModelInvocation(requestFor(policy));
    expect(invocation.profile.context.tokenEstimation).toBeUndefined();
    expect(invocation.profile.contextWindowTokens).toBe(16_384);
  });

  test.each(["ollama", "openai"])("preserves explicit %s calibration semantics", (provider) => {
    const policy = policyFor(provider);
    policy.profiles!.selected!.context = { tokenEstimation: { asciiCharactersPerToken: 3 } };
    policy.profiles!.selected!.calibration = {
      decision: { context: { tokenEstimation: { messageOverheadTokens: 8 } } },
    };
    policy.defaults!.steps = { "execution.decision": "decision" };
    expect(contextFor(policy).tokenEstimation).toEqual({ messageOverheadTokens: 8 });
  });

  test("keeps runtime headroom and hard admission on the complete request", () => {
    const invocation = resolveModelInvocation(requestFor(policyFor()));
    const budget = {
      contextWindowTokens: invocation.profile.contextWindowTokens,
      outputReserveTokens: 4096,
      safetyReserveTokens: 1200,
      attachmentReserveTokens: 100,
      tokenEstimation: invocation.profile.context.tokenEstimation,
    };
    const assessment = assessRequestMessagesBudget({
      messages: [{ role: "user", content: "a".repeat(120_000) }], budget,
      format: { schema: { type: "object", properties: { result: { type: "string" } } } },
    });
    expect(assessment.fits).toBe(false);
    expect(assessment.budget).toMatchObject({
      contextWindowTokens: 32_768, availableInputTokens: 27_472,
      outputReserveTokens: 4096, safetyReserveTokens: 1200,
    });
    expect(assessment.budget.formatReserveTokens).toBeGreaterThan(0);
    expect(assessment.budget.measuredInputTokens).toBeUndefined();
  });

  test("retains the final provider-envelope hard guard and estimate label", () => {
    const requestBody = requestFor(policyFor());
    const invocation = resolveModelInvocation(requestBody);
    const context = createProviderTraceContext({ endpoint: "chat", requestBody, invocation });
    const payload = { input: [{ role: "user", content: "a".repeat(140_000) }] };
    expect(resolveProviderEnvelopeInputTokens({
      payload, tokenEstimation: invocation.profile.context.tokenEstimation,
    })).toMatchObject({ measurement: "estimated", source: "runtime_token_estimator" });
    expect(() => assertFinalProviderEnvelopeFits({ context, invocation, payload }))
      .toThrow("model_context_window_exceeded");
  });
});
