import { describe, expect, test } from "vitest";
import { resolveModelInvocation } from "./invocation-policy.js";
import type {
  ModelGatewayPolicyConfig,
  ModelGenerationConfig,
  ModelReasoningPreference,
} from "../types.js";

function policy(
  generation: ModelGenerationConfig = {},
): ModelGatewayPolicyConfig {
  return {
    providers: { local: { type: "llamacpp" } },
    profiles: {
      local: {
        provider: "local",
        model: "test",
        contextWindowTokens: 32768,
        supportsThinking: true,
        generation,
        calibration: {
          compact: {
            generation: {
              reasoningEffort: "low",
              reasoningBudget: { mode: "tokens", tokens: 9 },
            },
          },
        },
      },
    },
    defaults: {
      profileId: "local",
      steps: {
        "context.compact": "compact",
        "supervisor.response": "response",
      },
    },
  };
}

const preferences: ModelReasoningPreference[] = [
  { profileId: "local", mode: "budget", budgetTokens: 512 },
  { profileId: "local", mode: "server-default" },
];

function invoke(
  modelPolicy: ModelGatewayPolicyConfig,
  reasoningPreference: ModelReasoningPreference,
  extra = {},
) {
  return resolveModelInvocation({
    modelPolicy,
    modelStep: "supervisor.response",
    agentMode: "deep",
    reasoningPreference,
    ...extra,
  });
}

describe("independent request reasoning effort and budget", () => {
  test.each(preferences)("Deep retains high with $mode", (preference) => {
    const result = invoke(policy(), preference);
    expect(result).toMatchObject({
      think: "high",
      reasoningControlSource: "request",
      reasoningBudget:
        preference.mode === "budget"
          ? { mode: "tokens", tokens: 512 }
          : { mode: "server-default" },
    });
  });

  test.each(["minimal", "low", "medium", "high", "xhigh"] as const)(
    "a manual limit preserves configured %s even in Low mode",
    (reasoningEffort) => {
      for (const preference of preferences) {
        expect(
          invoke(policy({ reasoningEffort }), preference, { agentMode: "fast" })
            .think,
        ).toBe(reasoningEffort);
      }
    },
  );

  test.each(preferences)(
    "$mode preserves the calibrated effort",
    (preference) => {
      const config = policy({ reasoningEffort: "xhigh" });
      config.profiles!.local.calibration!.response = {
        generation: { reasoningEffort: "low" },
      };
      expect(invoke(config, preference).think).toBe("low");
    },
  );

  test.each(preferences)(
    "$mode still enables Low and configured None",
    (preference) => {
      expect(invoke(policy(), preference, { agentMode: "fast" }).think).toBe(
        "medium",
      );
      expect(
        invoke(policy({ reasoningEffort: "none" }), preference).think,
      ).toBe("medium");
    },
  );

  test.each(preferences)(
    "$mode replaces a mapped budget without changing effort",
    (preference) => {
      const result = invoke(
        policy({
          reasoningEffort: "xhigh",
          reasoningBudgetByMode: { deep: 32 },
        }),
        preference,
      );
      expect(result.think).toBe("xhigh");
      expect(result.reasoningBudget).toEqual(
        preference.mode === "budget"
          ? { mode: "tokens", tokens: 512 }
          : { mode: "server-default" },
      );
    },
  );

  test("request Off still suppresses configured effort and a mode budget", () => {
    const result = invoke(
      policy({
        reasoningEffort: "xhigh",
        reasoningBudgetByMode: { deep: 32 },
      }),
      { profileId: "local", mode: "off" },
    );
    expect(result.think).toBe("none");
    expect(result.reasoningBudget).toBeUndefined();
  });

  test.each(preferences)("invocation Off remains above $mode", (preference) => {
    const result = invoke(policy({ reasoningEffort: "xhigh" }), preference, {
      reasoningOverride: "none",
    });
    expect(result.think).toBe("none");
    expect(result.reasoningBudget).toBeUndefined();
    expect(result.reasoningControlSource).toBe("invocation");
  });

  test("positive invocation effort remains above request Off", () => {
    const result = invoke(
      policy(),
      { profileId: "local", mode: "off" },
      {
        reasoningOverride: "minimal",
      },
    );
    expect(result.think).toBe("minimal");
    expect(result.reasoningBudget).toBeUndefined();
    expect(result.reasoningControlSource).toBe("invocation");
  });

  test.each([...preferences, { profileId: "local", mode: "off" } as const])(
    "utility calibration is independent of manual $mode",
    (preference) => {
      const result = invoke(
        policy({
          reasoningEffort: "xhigh",
          reasoningBudgetByMode: { deep: 32 },
        }),
        preference,
        {
          modelStep: "context.compact",
          modelPreference: { profileId: "local", scope: "all" },
        },
      );
      expect(result).toMatchObject({
        think: "low",
        reasoningBudget: { mode: "tokens", tokens: 9 },
        reasoningControlSource: "configuration",
      });
    },
  );
});
