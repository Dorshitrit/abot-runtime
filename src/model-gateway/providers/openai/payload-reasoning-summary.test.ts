import { describe, expect, test } from "vitest";
import { ModelReasoningConfigurationError } from "../../../shared/model-reasoning.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayProfileConfig, ModelGatewayRequest, ModelProvider } from "../../types.js";
import { buildChatGptResponsesPayload } from "../openai-chatgpt/payload.js";
import { controlsFormat } from "./__tests__/native-function-fixture.js";
import { buildOpenAIInputTokenCountPayload, buildOpenAIResponsesPayload } from "./payload.js";
import { requestsOpenAIReasoningSummary, resolveOpenAIReasoningSummary } from "./reasoning-summary-options.js";

function summaryRequest(
  summary?: unknown,
  profile: Partial<ModelGatewayProfileConfig> = {},
  provider: ModelProvider = "openai",
): ModelGatewayRequest {
  return {
    modelStep: "execution.response",
    messages: [{ role: "user", content: "Explain the result." }],
    modelPolicy: {
      providers: { remote: { type: provider } },
      profiles: {
        test: {
          provider: "remote", model: "fixture", contextWindowTokens: 32_768,
          supportsThinking: true, options: { reasoningSummary: summary }, ...profile,
        },
      },
      defaults: { profileId: "test" },
    },
  };
}

describe("OpenAI reasoning summary opt-in", () => {
  test.each([undefined, null])("keeps the complete default payload unchanged for %s", (summary) => {
    const disabled = summaryRequest(undefined, { options: {} });
    expect(buildOpenAIResponsesPayload(summaryRequest(summary))).toEqual(buildOpenAIResponsesPayload(disabled));
    expect(buildOpenAIResponsesPayload(disabled).reasoning).toEqual({ effort: "medium" });
  });

  test.each(["auto", "concise", "detailed"])("projects %s without changing any other generation field", (summary) => {
    const baseline = buildOpenAIResponsesPayload(summaryRequest());
    expect(buildOpenAIResponsesPayload(summaryRequest(summary))).toEqual({
      ...baseline, reasoning: { effort: "medium", summary },
    });
  });

  test("requests a summary without inventing effort or requiring explicit effort controls", () => {
    const baseline = buildOpenAIResponsesPayload(summaryRequest(undefined, { supportsThinking: false }));
    expect(baseline).not.toHaveProperty("reasoning");
    expect(buildOpenAIResponsesPayload(summaryRequest("auto", { supportsThinking: false }))).toEqual({
      ...baseline, reasoning: { summary: "auto" },
    });
  });

  test.each(["auto", "concise", "detailed"])("respects explicit Off with %s configured", (summary) => {
    const request = { ...summaryRequest(summary), reasoningOverride: "none" };
    const baseline = { ...summaryRequest(), reasoningOverride: "none" };
    expect(buildOpenAIResponsesPayload(request)).toEqual(buildOpenAIResponsesPayload(baseline));
    expect(buildOpenAIResponsesPayload(request).reasoning).toEqual({ effort: "none" });
  });

  test.each(["", "AUTO", "disabled", true, false, 0, [], {}].map((value) => ({ value })))(
    "rejects an invalid option before building a provider payload: $value", ({ value }) => {
      expect(() => buildOpenAIResponsesPayload(summaryRequest(value))).toThrow(ModelReasoningConfigurationError);
      expect(() => buildOpenAIResponsesPayload(summaryRequest(value))).toThrow("invalid_openai_reasoning_summary");
    },
  );

  test("validates configuration even when effort is off", () => {
    expect(() => buildOpenAIResponsesPayload({ ...summaryRequest(false), reasoningOverride: "none" }))
      .toThrow("invalid_openai_reasoning_summary");
  });

  test.each(["openai-chatgpt", "ollama", "llamacpp"])("does not interpret the option for %s", (provider) => {
    expect(resolveOpenAIReasoningSummary(resolveModelInvocation(summaryRequest("auto", {}, provider)))).toBeUndefined();
    expect(resolveOpenAIReasoningSummary(resolveModelInvocation(summaryRequest(false, {}, provider)))).toBeUndefined();
  });

  test.each(["auto", "concise", "detailed", false, null])("keeps the ChatGPT payload unchanged for %s", (summary) => {
    expect(buildChatGptResponsesPayload(summaryRequest(summary, {}, "openai-chatgpt")))
      .toEqual(buildChatGptResponsesPayload(summaryRequest(undefined, {}, "openai-chatgpt")));
  });

  test("gates streaming on the actual API payload independently from the stored option", () => {
    const invocation = resolveModelInvocation(summaryRequest("auto"));
    expect(requestsOpenAIReasoningSummary(invocation, {})).toBe(false);
    expect(requestsOpenAIReasoningSummary(invocation, { reasoning: { effort: "medium" } })).toBe(false);
    expect(requestsOpenAIReasoningSummary(invocation, { reasoning: { summary: "invalid" } })).toBe(false);
    expect(requestsOpenAIReasoningSummary(invocation, { reasoning: { summary: "auto" } })).toBe(true);
    const chatGpt = resolveModelInvocation(summaryRequest("auto", {}, "openai-chatgpt"));
    expect(requestsOpenAIReasoningSummary(chatGpt, { reasoning: { summary: "auto" } })).toBe(false);
  });
});

describe("OpenAI summary formatting and input accounting", () => {
  test.each([
    { modelStep: "execution.response", format: undefined },
    { modelStep: "supervisor.decision", format: "json" },
    { modelStep: "supervisor.decision", format: controlsFormat },
    { modelStep: "execution.decision", format: controlsFormat },
    { modelStep: "capability.controls", format: controlsFormat },
    { modelStep: "context.compact", format: controlsFormat },
    { modelStep: "tool_payload.raw", format: undefined },
  ] satisfies Pick<ModelGatewayRequest, "modelStep" | "format">[])("preserves content/function projection for $modelStep with $format", ({ modelStep, format }) => {
    const request = { ...summaryRequest("auto"), modelStep, format };
    const baseline = { ...summaryRequest(), modelStep, format };
    expect(buildOpenAIResponsesPayload(request)).toEqual({
      ...buildOpenAIResponsesPayload(baseline), reasoning: { effort: "medium", summary: "auto" },
    });
    expect(buildOpenAIInputTokenCountPayload(request)).toEqual(buildOpenAIInputTokenCountPayload(baseline));
  });

  test.each([true, false])("omits summary from counting with explicit effort controls=%s", (supportsThinking) => {
    const request = summaryRequest("detailed", { supportsThinking });
    const baseline = summaryRequest(undefined, { supportsThinking });
    expect(buildOpenAIInputTokenCountPayload(request)).toEqual(buildOpenAIInputTokenCountPayload(baseline));
    expect(buildOpenAIResponsesPayload(request).reasoning).toMatchObject({ summary: "detailed" });
  });
});
