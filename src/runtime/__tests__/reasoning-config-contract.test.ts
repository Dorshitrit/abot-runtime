import { describe, expect, test } from "vitest";
import { buildModelGenerationConfig } from "../config/builders.js";
import { validateModelGenerationConfig } from "../config/validation/model-invocation-config-validation.js";
import { validateEffectiveReasoningBudgets } from "../config/model-reasoning-validation.js";
import { validateLlamaCppProfileCapabilities } from "../config/llamacpp-profile-validation.js";
import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import {
  readCreatedModelReasoningControls,
  readModelReasoningControlPatch,
} from "../capabilities/model-reasoning-controls.js";

describe("reasoning configuration and authoring", () => {
  test("manual llama profiles cannot advertise image input through a text-only adapter", () => {
    const issues: string[] = [];
    validateLlamaCppProfileCapabilities(issues, {
      providers: { llama: { type: "llamacpp" }, ollama: { type: "ollama" } },
      profiles: {
        invalid: {
          provider: "llama",
          model: "test",
          capabilities: { inputModalities: ["text", "image"] },
        },
        text: {
          provider: "llama",
          model: "test",
          capabilities: { inputModalities: ["text"] },
        },
        image: {
          provider: "ollama",
          model: "test",
          capabilities: { inputModalities: ["text", "image"] },
        },
      },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("profiles.invalid");
  });
  test("builders preserve typed budgets and validation rejects fractional values", () => {
    expect(
      buildModelGenerationConfig({
        reasoningEffort: "none",
        reasoningBudget: { mode: "tokens", tokens: 512 },
      }),
    ).toEqual({
      reasoningEffort: "none",
      reasoningBudget: { mode: "tokens", tokens: 512 },
    });
    const issues: string[] = [];
    validateModelGenerationConfig(
      issues,
      { reasoningBudget: { mode: "tokens", tokens: 1.5 } },
      "generation",
    );
    expect(issues).toHaveLength(1);
    expect(() =>
      buildModelGenerationConfig({
        reasoningBudget: { mode: "tokens", tokens: -1 },
      }),
    ).toThrow();
  });
  test("materialized config checks calibration target capability", () => {
    const config: ModelGatewayPolicyConfig = {
      providers: { local: { type: "llamacpp" }, other: { type: "ollama" } },
      profiles: {
        gemma: {
          provider: "local",
          model: "gemma",
          supportsThinking: true,
          generation: {
            reasoningEffort: "none",
            reasoningBudget: { mode: "tokens", tokens: 512 },
          },
          calibration: {
            utility: {
              profileId: "other",
              generation: { reasoningBudget: { mode: "tokens", tokens: 128 } },
            },
          },
        },
        other: { provider: "other", model: "other", supportsThinking: true },
      },
    };
    const issues: string[] = [];
    validateEffectiveReasoningBudgets(issues, config);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("calibration.utility");
    delete config.profiles!.gemma.calibration;
    const valid: string[] = [];
    validateEffectiveReasoningBudgets(valid, config);
    expect(valid).toEqual([]);
  });
  test("flat tools preserve omit, clear and finite semantics without adding an object input", () => {
    expect(readModelReasoningControlPatch({}, "gemma")).toEqual({});
    expect(
      readModelReasoningControlPatch({ reasoningMode: "inherit" }, "gemma"),
    ).toEqual({ reasoningPreference: null });
    expect(
      readCreatedModelReasoningControls({ reasoningMode: "inherit" }, "gemma"),
    ).toEqual({});
    expect(
      readCreatedModelReasoningControls(
        { reasoningMode: "budget", reasoningBudgetTokens: 512 },
        "gemma",
      ),
    ).toEqual({
      reasoningPreference: {
        profileId: "gemma",
        mode: "budget",
        budgetTokens: 512,
      },
    });
    expect(() =>
      readModelReasoningControlPatch({ reasoningBudgetTokens: 512 }, "gemma"),
    ).toThrow();
  });
});
