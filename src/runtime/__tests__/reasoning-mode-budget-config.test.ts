import { describe, expect, test } from "vitest";
import { buildModelGenerationConfig } from "../config/builders.js";
import { validateModelGenerationConfig } from "../config/validation/model-invocation-config-validation.js";
import { validateEffectiveReasoningBudgets } from "../config/model-reasoning-validation.js";
import { createRuntimeConfigJsonSchema } from "../config/schema.js";
import type {
  ModelGatewayPolicyConfig,
  ModelGenerationConfig,
} from "../../model-gateway/types.js";

function generation(reasoningBudgetByMode: unknown): ModelGenerationConfig {
  return { reasoningBudgetByMode } as ModelGenerationConfig;
}

describe("reasoning mode budget configuration", () => {
  test("builders preserve sparse maps and explicit empty maps without defaults", () => {
    expect(buildModelGenerationConfig({ temperature: 0.2 })).toEqual({
      temperature: 0.2,
    });
    for (const map of [{}, { fast: 0 }, { fast: 32 }, { reasoning: 64, deep: 2147483647 }]) {
      expect(buildModelGenerationConfig(generation(map))).toEqual(
        generation(map),
      );
    }
  });
  test.each([
    null,
    [],
    32,
    { auto: 32 },
    { deep: -1 },
    { reasoning: 1.5 },
    { fast: NaN },
    { fast: Infinity },
    { fast: 2147483648 },
    { fast: "32" },
    { fast: { mode: "tokens", tokens: 32 } },
  ])("rejects an invalid map %j before building", (map) => {
    const issues: string[] = [];
    validateModelGenerationConfig(
      issues,
      generation(map) as Record<string, unknown>,
      "generation",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("generation.reasoningBudgetByMode");
    expect(() => buildModelGenerationConfig(generation(map))).toThrow();
  });
  test("schema allows sparse non-negative finite budget fields", () => {
    const schema = createRuntimeConfigJsonSchema();
    const finiteBudget = { type: "integer", minimum: 0, maximum: 2147483647 };
    const expected = expect.objectContaining({
      type: "object",
      additionalProperties: false,
      properties: {
        fast: finiteBudget,
        reasoning: finiteBudget,
        deep: finiteBudget,
      },
    });
    for (const path of [
      "properties.models.properties.profiles.additionalProperties.properties.generation.properties.reasoningBudgetByMode",
      "properties.models.properties.profiles.additionalProperties.properties.calibration.additionalProperties.properties.generation.properties.reasoningBudgetByMode",
      "properties.models.properties.invocationProfiles.additionalProperties.properties.generation.properties.reasoningBudgetByMode",
    ])
      expect(schema).toHaveProperty(path, expected);
  });
  test.each(["openai", "ollama", "no-thinking"])(
    "validates profile, calibration target and invocation capability: %s",
    (kind) => {
      const config: ModelGatewayPolicyConfig = {
        providers: {
          local: { type: "llamacpp" },
          other: { type: kind === "no-thinking" ? "llamacpp" : kind },
        },
        profiles: {
          local: {
            provider: "local",
            model: "test",
            supportsThinking: true,
            generation: generation({ fast: 32 }),
            calibration: {
              response: {
                profileId: "other",
                generation: generation({ deep: 128 }),
              },
            },
          },
          other: {
            provider: "other",
            model: "test",
            supportsThinking: kind !== "no-thinking",
            generation: generation({}),
          },
        },
        invocationProfiles: {
          custom: {
            profileId: "other",
            generation: generation({ reasoning: 64 }),
          },
        },
      };
      const issues: string[] = [];
      validateEffectiveReasoningBudgets(issues, config);
      expect(issues).toHaveLength(3);
      expect(
        issues.some((issue) =>
          issue.includes(
            "calibration.response.generation.reasoningBudgetByMode",
          ),
        ),
      ).toBe(true);
      expect(
        issues.some((issue) =>
          issue.includes("profiles.other.generation.reasoningBudgetByMode"),
        ),
      ).toBe(true);
      expect(
        issues.some((issue) =>
          issue.includes(
            "invocationProfiles.custom.generation.reasoningBudgetByMode",
          ),
        ),
      ).toBe(true);
    },
  );
  test("valid llama maps are accepted in every generation scope", () => {
    const config: ModelGatewayPolicyConfig = {
      providers: { local: { type: "llamacpp" } },
      profiles: {
        local: {
          provider: "local",
          model: "test",
          supportsThinking: true,
          generation: generation({ fast: 32 }),
          calibration: { response: { generation: generation({}) } },
        },
      },
      invocationProfiles: {
        custom: { profileId: "local", generation: generation({ deep: 128 }) },
      },
    };
    const issues: string[] = [];
    validateEffectiveReasoningBudgets(issues, config);
    expect(issues).toEqual([]);
  });
});
