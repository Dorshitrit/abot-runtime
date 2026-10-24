import { describe, expect, test } from "vitest";
import { resolveModelInvocation } from "./invocation-policy.js";
import { buildLlamaCppChatPayload } from "../providers/llamacpp/payload.js";
import type {
  ModelGatewayPolicyConfig,
  ModelGenerationConfig,
} from "../types.js";

function policy(
  generation: ModelGenerationConfig = {},
): ModelGatewayPolicyConfig {
  return {
    providers: {
      local: { type: "llamacpp" },
      openai: { type: "openai" },
      ollama: { type: "ollama" },
    },
    profiles: {
      local: {
        provider: "local",
        model: "test",
        contextWindowTokens: 32768,
        supportsThinking: true,
        generation,
      },
      openai: {
        provider: "openai",
        model: "test",
        contextWindowTokens: 32768,
        supportsThinking: true,
      },
      ollama: {
        provider: "ollama",
        model: "test",
        contextWindowTokens: 32768,
        supportsThinking: true,
      },
    },
    defaults: {
      profileId: "local",
      steps: {
        "supervisor.response": "response",
        "context.compact": "compact",
      },
    },
  };
}

const mapped = (extra: ModelGenerationConfig = {}) =>
  ({
    reasoningBudgetByMode: { fast: 32, reasoning: 64, deep: 128 },
    ...extra,
  }) as ModelGenerationConfig;

function invoke(
  modelPolicy: ModelGatewayPolicyConfig,
  agentMode = "fast",
  extra = {},
) {
  return resolveModelInvocation({
    modelPolicy,
    agentMode,
    modelStep: "supervisor.response",
    ...extra,
  });
}

describe("configured reasoning budgets by mode", () => {
  test.each(["local", "openai", "ollama"])(
    "%s retains common default modes without an override",
    (profileId) => {
      const config = policy();
      for (const [mode, think] of [
        ["fast", "none"],
        ["reasoning", "medium"],
        ["deep", "high"],
      ]) {
        expect(
          invoke(config, mode, { modelPreference: { profileId } }),
        ).toMatchObject({ think });
        expect(
          invoke(config, mode, { modelPreference: { profileId } })
            .reasoningBudget,
        ).toBeUndefined();
      }
    },
  );
  test.each(["none", "xhigh"] as const)(
    "unmapped presets retain configured %s effort priority",
    (reasoningEffort) => {
      expect(invoke(policy({ reasoningEffort }), "deep").think).toBe(
        reasoningEffort,
      );
    },
  );
  test.each([
    ["fast", 32, "medium"],
    ["reasoning", 64, "medium"],
    ["deep", 128, "high"],
  ])(
    "%s selects its explicit budget and enables thinking",
    (mode, tokens, think) => {
      const result = invoke(policy(mapped()), String(mode));
      expect(result).toMatchObject({
        think,
        reasoningBudget: { mode: "tokens", tokens },
        reasoningControlSource: "configuration",
      });
      const payload = buildLlamaCppChatPayload({
        invocation: result,
        endpoint: "chat",
        requestBody: { messages: [] },
      });
      expect(payload).toMatchObject({
        reasoning_budget_tokens: tokens,
        chat_template_kwargs: { enable_thinking: true },
      });
    },
  );
  test.each(["none", "xhigh"] as const)(
    "mapping activates configured none but preserves positive effort: %s",
    (reasoningEffort) => {
      expect(invoke(policy(mapped({ reasoningEffort }))).think).toBe(
        reasoningEffort === "none" ? "medium" : "xhigh",
      );
    },
  );
  test("a matching map overrides generic budget; an unmapped mode retains it", () => {
    const config = policy({
      reasoningEffort: "high",
      reasoningBudget: { mode: "tokens", tokens: 900 },
      reasoningBudgetByMode: { fast: 32 },
    } as ModelGenerationConfig);
    expect(invoke(config).reasoningBudget).toEqual({
      mode: "tokens",
      tokens: 32,
    });
    expect(invoke(config, "deep").reasoningBudget).toEqual({
      mode: "tokens",
      tokens: 900,
    });
  });
  test.each(["off", "server-default", "budget"] as const)(
    "explicit request %s overrides the map",
    (mode) => {
      const preference =
        mode === "budget"
          ? { profileId: "local", mode, budgetTokens: 7 }
          : { profileId: "local", mode };
      const result = invoke(policy(mapped()), "deep", {
        reasoningPreference: preference,
      });
      expect(result.think).toBe(mode === "off" ? "none" : "high");
      expect(result.reasoningBudget).toEqual(
        mode === "off"
          ? undefined
          : mode === "budget"
            ? { mode: "tokens", tokens: 7 }
            : { mode: "server-default" },
      );
    },
  );
  test("invocation Off suppresses a mapped budget; a positive invocation effort remains exact", () => {
    const config = policy(mapped());
    expect(invoke(config, "fast", { reasoningOverride: "none" })).toMatchObject(
      { think: "none" },
    );
    expect(
      invoke(config, "fast", { reasoningOverride: "none" }).reasoningBudget,
    ).toBeUndefined();
    expect(invoke(config, "fast", { reasoningOverride: "high" })).toMatchObject(
      { think: "high", reasoningBudget: { mode: "tokens", tokens: 32 } },
    );
  });
  test.each(["context.compact", "tool_payload.raw", "learning.batch"])(
    "%s retains its own policy",
    (modelStep) => {
      const config = policy(
        mapped({
          reasoningEffort: "xhigh",
          reasoningBudget: { mode: "tokens", tokens: 400 },
        }),
      );
      config.profiles!.local.calibration = {
        compact: {
          generation: {
            reasoningEffort: "none",
            reasoningBudget: { mode: "tokens", tokens: 9 },
          },
        },
      };
      const result = invoke(config, "fast", {
        modelStep,
        reasoningPreference: { profileId: "local", mode: "off" },
      });
      expect(result.think).toBe(
        modelStep === "context.compact" ? "none" : "xhigh",
      );
      expect(result.reasoningBudget).toEqual(
        modelStep === "context.compact"
          ? undefined
          : { mode: "tokens", tokens: 400 },
      );
    },
  );
  test("direct gateway calls use the map; auto does not invent a mapping", () => {
    const config = policy(mapped());
    expect(
      invoke(config, "fast", { modelStep: undefined }).reasoningBudget,
    ).toEqual({ mode: "tokens", tokens: 32 });
    expect(invoke(config, "auto").reasoningBudget).toBeUndefined();
  });
  test("calibration replaces the whole map, an empty map clears it, omission inherits", () => {
    const config = policy(mapped());
    config.profiles!.local.calibration = {
      response: {
        generation: {
          reasoningBudgetByMode: { deep: 7 },
        } as ModelGenerationConfig,
      },
    };
    expect(invoke(config).reasoningBudget).toBeUndefined();
    expect(invoke(config, "deep").reasoningBudget).toEqual({
      mode: "tokens",
      tokens: 7,
    });
    config.profiles!.local.calibration!.response.generation = {
      reasoningBudgetByMode: {},
    } as ModelGenerationConfig;
    expect(invoke(config, "deep").reasoningBudget).toBeUndefined();
    config.profiles!.local.calibration!.response.generation = {
      temperature: 0.2,
    };
    expect(invoke(config).reasoningBudget).toEqual({
      mode: "tokens",
      tokens: 32,
    });
  });
  test("legacy invocation overlays replace maps, including an empty clear", () => {
    const config = policy(mapped());
    config.invocationProfiles = {
      custom: {
        profileId: "local",
        generation: { reasoningBudgetByMode: {} } as ModelGenerationConfig,
      },
    };
    config.defaults!.steps!["supervisor.response"] = "custom";
    expect(invoke(config).reasoningBudget).toBeUndefined();
  });
  test("a redirected calibration uses the target map only", () => {
    const config = policy(mapped());
    config.profiles!.target = {
      ...config.profiles!.local,
      generation: {
        reasoningBudgetByMode: { fast: 6 },
      } as ModelGenerationConfig,
    };
    config.profiles!.local.calibration = { response: { profileId: "target" } };
    expect(invoke(config).reasoningBudget).toEqual({
      mode: "tokens",
      tokens: 6,
    });
  });
  test.each(["openai", "ollama"])(
    "direct configuration rejects maps for %s",
    (provider) => {
      const config = policy(mapped());
      config.profiles!.local.provider = provider;
      expect(() => invoke(config)).toThrow("reasoning_budget_unsupported");
    },
  );
});
