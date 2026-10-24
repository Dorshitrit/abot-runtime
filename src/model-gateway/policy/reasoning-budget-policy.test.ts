import { describe, expect, test } from "vitest";
import { resolveModelInvocation } from "./invocation-policy.js";
import type {
  ModelGatewayPolicyConfig,
  ModelReasoningPreference,
} from "../types.js";
import { buildChatGatewayRequestBody } from "../client/message-projection.js";

function policy(): ModelGatewayPolicyConfig {
  return {
    providers: {
      local: { type: "llamacpp", baseUrl: "http://localhost:8080" },
      remote: { type: "openai" },
    },
    profiles: {
      gemma: {
        provider: "local",
        model: "gemma",
        contextWindowTokens: 32768,
        supportsThinking: true,
        generation: {
          reasoningEffort: "none",
          reasoningBudget: { mode: "tokens", tokens: 100 },
        },
        calibration: {
          response: {
            generation: { reasoningBudget: { mode: "tokens", tokens: 200 } },
          },
        },
      },
      other: {
        provider: "local",
        model: "other",
        contextWindowTokens: 32768,
        supportsThinking: true,
      },
      openai: {
        provider: "remote",
        model: "remote",
        contextWindowTokens: 32768,
        supportsThinking: true,
      },
    },
    defaults: {
      profileId: "gemma",
      steps: { "supervisor.response": "response" },
    },
  };
}

describe("profile-bound reasoning budgets", () => {
  test("a request explicitly enables thinking over fast and calibrated none", () => {
    const result = resolveModelInvocation({
      agentMode: "fast",
      modelStep: "supervisor.response",
      modelPolicy: policy(),
      reasoningPreference: {
        profileId: "gemma",
        mode: "budget",
        budgetTokens: 512,
      },
    });
    expect(result).toMatchObject({
      think: "medium",
      reasoningBudget: { mode: "tokens", tokens: 512 },
      reasoningControlSource: "request",
    });
  });

  test.each(["off", "server-default"] as const)(
    "explicit %s replaces the configured numeric budget",
    (mode) => {
      const result = resolveModelInvocation({
        agentMode: "deep",
        modelPolicy: policy(),
        reasoningPreference: { profileId: "gemma", mode },
      });
      expect(result.think).toBe(mode === "off" ? "none" : "medium");
      expect(result.reasoningBudget).toEqual(
        mode === "off" ? undefined : { mode: "server-default" },
      );
    },
  );

  test("per-invocation none disables an explicit finite budget", () => {
    const result = resolveModelInvocation({
      modelPolicy: policy(),
      reasoningOverride: "none",
      reasoningPreference: {
        profileId: "gemma",
        mode: "budget",
        budgetTokens: 512,
      },
    });
    expect(result.think).toBe("none");
    expect(result).not.toHaveProperty("reasoningBudget");
  });

  test("positive per-invocation effort retains the selected numeric limit", () => {
    const result = resolveModelInvocation({
      modelPolicy: policy(),
      reasoningOverride: "high",
      reasoningPreference: {
        profileId: "gemma",
        mode: "budget",
        budgetTokens: 512,
      },
    });
    expect(result).toMatchObject({
      think: "high",
      reasoningBudget: { mode: "tokens", tokens: 512 },
    });
  });

  test("absence preserves disabled profile semantics; budget alone does not enable", () => {
    const result = resolveModelInvocation({
      modelPolicy: policy(),
      agentMode: "deep",
    });
    expect(result.think).toBe("none");
    expect(result.reasoningBudget).toBeUndefined();
  });

  test("calibration budget wins over profile budget when enabled", () => {
    const config = policy();
    config.profiles!.gemma.generation!.reasoningEffort = "medium";
    expect(
      resolveModelInvocation({
        modelPolicy: config,
        modelStep: "supervisor.response",
      }).reasoningBudget,
    ).toEqual({ mode: "tokens", tokens: 200 });
  });

  test.each(["context.compact", "tool_payload.raw", "learning.batch"])(
    "%s retains its own policy despite preference scope all",
    (modelStep) => {
      const result = resolveModelInvocation({
        modelPolicy: policy(),
        modelStep,
        modelPreference: { profileId: "gemma", scope: "all" },
        reasoningPreference: {
          profileId: "gemma",
          mode: "budget",
          budgetTokens: 512,
        },
      });
      expect(result.think).toBe("none");
      expect(result.reasoningBudget).toBeUndefined();
    },
  );

  test.each(["other", "openai"])(
    "calibration target %s never inherits the other profile's request budget",
    (profileId) => {
      const config = policy();
      config.profiles!.gemma.calibration!.response = { profileId };
      const result = resolveModelInvocation({
        modelPolicy: config,
        modelStep: "supervisor.response",
        reasoningPreference: {
          profileId: "gemma",
          mode: "budget",
          budgetTokens: 512,
        },
      });
      expect(result.profile.id).toBe(profileId);
      expect(result.reasoningBudget).toBeUndefined();
      expect(result.think).toBe("medium");
    },
  );

  test("unsupported or unknown bound profiles are explicit errors", () => {
    for (const profileId of ["openai", "missing"]) {
      expect(() =>
        resolveModelInvocation({
          modelPolicy: policy(),
          reasoningPreference: { profileId, mode: "budget", budgetTokens: 512 },
        }),
      ).toThrow();
    }
  });

  test("legacy provider calls retain their old resolved fields", () => {
    const config = policy();
    const result = resolveModelInvocation({
      modelPolicy: config,
      modelPreference: { profileId: "openai" },
      agentMode: "fast",
    });
    expect(Object.keys(result).sort()).toEqual(["model", "profile", "think"]);
    expect(result.think).toBe("none");
  });

  test("wire metadata never becomes prompt content", () => {
    const reasoningPreference: ModelReasoningPreference = {
      profileId: "gemma",
      mode: "budget",
      budgetTokens: 512,
    };
    const messages = [
      { role: "user" as const, content: "Keep this exact user text." },
    ];
    const body = buildChatGatewayRequestBody(
      { agentMode: "fast", reasoningPreference },
      messages,
      policy(),
    );
    expect(body.reasoningPreference).toEqual(reasoningPreference);
    expect(body.messages).toEqual(messages);
  });
});
