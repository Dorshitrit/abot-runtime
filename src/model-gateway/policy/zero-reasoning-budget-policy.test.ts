import { describe, expect, test } from "vitest";
import { resolveModelInvocation } from "./invocation-policy.js";
import { buildLlamaCppChatPayload } from "../providers/llamacpp/payload.js";
import type {
  ModelGatewayPolicyConfig,
  ModelGatewayRequest,
  ModelGenerationConfig,
} from "../types.js";

function policy(
  generation: ModelGenerationConfig = {},
): ModelGatewayPolicyConfig {
  return {
    providers: { local: { type: "llamacpp" }, remote: { type: "openai" } },
    profiles: {
      gemma: {
        provider: "local",
        model: "fixture",
        contextWindowTokens: 32768,
        supportsThinking: true,
        generation: { reasoningEffort: "xhigh", ...generation },
      },
      other: {
        provider: "local",
        model: "other",
        contextWindowTokens: 32768,
        supportsThinking: true,
        generation: { reasoningEffort: "high" },
      },
      remote: {
        provider: "remote",
        model: "remote",
        contextWindowTokens: 32768,
        supportsThinking: true,
        generation: { reasoningEffort: "high" },
      },
    },
    defaults: {
      profileId: "gemma",
      steps: { "supervisor.response": "response" },
    },
  };
}

function invoke(
  modelPolicy: ModelGatewayPolicyConfig,
  extra: Partial<ModelGatewayRequest> = {},
) {
  return resolveModelInvocation({
    modelPolicy,
    modelStep: "supervisor.response",
    agentMode: "deep",
    ...extra,
  });
}
const zero = { mode: "tokens" as const, tokens: 0 };

function expectDisabled(result: ReturnType<typeof invoke>) {
  expect(result.think).toBe("none");
  expect(result.reasoningBudget).toBeUndefined();
  const payload = buildLlamaCppChatPayload({
    invocation: result,
    endpoint: "chat",
    requestBody: { text: "hello" },
  });
  expect(payload).toMatchObject({
    reasoning_effort: "none",
    reasoning_budget_tokens: 0,
    chat_template_kwargs: { enable_thinking: false },
  });
  expect(payload.messages).toEqual([{ role: "user", content: "hello" }]);
}

describe("zero reasoning budget is disabled thinking", () => {
  test("zero disables xhigh without rewriting the stored effort", () => {
    const config = policy({ reasoningBudget: zero });
    const before = structuredClone(config);
    expectDisabled(invoke(config));
    expect(config).toEqual(before);
    config.profiles!.gemma!.generation!.reasoningBudget = {
      mode: "tokens",
      tokens: 64,
    };
    expect(invoke(config)).toMatchObject({
      think: "xhigh",
      reasoningBudget: { mode: "tokens", tokens: 64 },
    });
  });

  test("a calibrated zero affects only its selected step", () => {
    const config = policy({ reasoningBudget: { mode: "tokens", tokens: 64 } });
    config.profiles!.gemma!.calibration = {
      response: { generation: { reasoningBudget: zero } },
    };
    expectDisabled(invoke(config));
    expect(invoke(config, { modelStep: "supervisor.routing" })).toMatchObject({
      think: "xhigh",
      reasoningBudget: { mode: "tokens", tokens: 64 },
    });
  });

  test("a zero mode overrides the generic budget only for that main preset", () => {
    const config = policy({
      reasoningBudget: { mode: "tokens", tokens: 64 },
      reasoningBudgetByMode: { fast: 0, deep: 128 },
    });
    expectDisabled(invoke(config, { agentMode: "fast" }));
    expect(invoke(config)).toMatchObject({
      think: "xhigh",
      reasoningBudget: { mode: "tokens", tokens: 128 },
    });
    expect(
      invoke(config, { agentMode: "fast", modelStep: "context.compact" }),
    ).toMatchObject({
      think: "xhigh",
      reasoningBudget: { mode: "tokens", tokens: 64 },
    });
  });

  test("request zero overrides positive configuration and a positive request overrides configured zero", () => {
    const config = policy({ reasoningBudget: { mode: "tokens", tokens: 64 } });
    expectDisabled(
      invoke(config, {
        reasoningPreference: {
          profileId: "gemma",
          mode: "budget",
          budgetTokens: 0,
        },
      }),
    );
    config.profiles!.gemma!.generation!.reasoningBudget = zero;
    expect(
      invoke(config, {
        reasoningPreference: {
          profileId: "gemma",
          mode: "budget",
          budgetTokens: 32,
        },
      }),
    ).toMatchObject({
      think: "xhigh",
      reasoningBudget: { mode: "tokens", tokens: 32 },
      reasoningControlSource: "request",
    });
    expect(
      invoke(config, {
        reasoningPreference: { profileId: "gemma", mode: "server-default" },
      }),
    ).toMatchObject({
      think: "xhigh",
      reasoningBudget: { mode: "server-default" },
    });
  });

  test("request zero stays bound to its profile and main lane", () => {
    const config = policy({ reasoningBudget: { mode: "tokens", tokens: 64 } });
    const reasoningPreference = {
      profileId: "gemma",
      mode: "budget" as const,
      budgetTokens: 0,
    };
    expect(
      invoke(config, { modelStep: "context.compact", reasoningPreference }),
    ).toMatchObject({
      think: "xhigh",
      reasoningBudget: { mode: "tokens", tokens: 64 },
    });
    config.profiles!.gemma!.calibration = { response: { profileId: "other" } };
    expect(invoke(config, { reasoningPreference })).toMatchObject({
      think: "high",
      profile: { id: "other" },
    });
    expect(
      invoke(config, { reasoningPreference }).reasoningBudget,
    ).toBeUndefined();
  });

  test("invocation overrides retain their existing priority over zero", () => {
    const config = policy({ reasoningBudget: zero });
    const enabled = invoke(config, { reasoningOverride: "high" });
    expect(enabled.think).toBe("high");
    expect(enabled.reasoningBudget).toBeUndefined();
    expectDisabled(invoke(config, { reasoningOverride: "none" }));
    config.profiles!.gemma!.generation!.reasoningBudget = {
      mode: "tokens",
      tokens: 64,
    };
    expectDisabled(invoke(config, { reasoningOverride: "none" }));
  });

  test("an unused zero profile leaves a different provider unchanged", () => {
    const config = policy({ reasoningBudget: zero });
    expect(
      invoke(config, { modelPreference: { profileId: "remote" } }),
    ).toMatchObject({
      think: "high",
      profile: { id: "remote", provider: "openai" },
    });
  });
});
