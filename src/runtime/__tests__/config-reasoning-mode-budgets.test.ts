import { describe, expect, test } from "vitest";
import { configReasoningHarness } from "./support/config-reasoning-consistency-harness.js";
import { resolveModelInvocation } from "../../model-gateway/policy/invocation-policy.js";

const mapPath = ["generation", "reasoningBudgetByMode"];

describe("mode budget configuration controls", () => {
  test("creates optional mode limits without replacing the general budget or effort", () => {
    const harness = configReasoningHarness({ effort: "none", budget: { mode: "tokens", tokens: 512 } });
    expect(harness.render()).toContain("Mode token overrides");
    harness.field(mapPath, "custom", "reasoning-mode-budgets");
    expect(harness.file.config.generation.reasoningBudgetByMode).toEqual({});
    expect(harness.render()).toContain("Low thinking tokens");
    expect(harness.render()).toContain("None disables thinking unless a mode token limit or request setting enables it.");
    expect(harness.render()).toContain("blank entries use the ordinary effort and budget settings.");
    harness.renderConfigDashboard.mockClear();
    harness.field([...mapPath, "fast"], "3", "number");
    harness.field([...mapPath, "fast"], "32", "number");
    expect(harness.renderConfigDashboard).not.toHaveBeenCalled();
    expect(harness.file.config.generation).toEqual({
      reasoningEffort: "none",
      reasoningBudget: { mode: "tokens", tokens: 512 },
      reasoningBudgetByMode: { fast: 32 },
    });
    expect(harness.resolve()).toMatchObject({ think: "medium", reasoningBudget: { mode: "tokens", tokens: 32 } });
    expect(resolveModelInvocation({ modelPolicy: harness.policy(), agentMode: "deep" })).toMatchObject({ think: "none" });
  });

  test("blank removes one mode, and Inherit removes only the map", () => {
    const harness = configReasoningHarness({ effort: "high", budget: { mode: "tokens", tokens: 512 } });
    harness.field(mapPath, "custom", "reasoning-mode-budgets");
    harness.field([...mapPath, "fast"], "32", "number");
    harness.field([...mapPath, "deep"], "1024", "number");
    harness.field([...mapPath, "fast"], "", "number");
    expect(harness.file.config.generation.reasoningBudgetByMode).toEqual({ deep: 1024 });
    harness.field(mapPath, "inherit", "reasoning-mode-budgets");
    expect(harness.file.config.generation).toEqual({ reasoningEffort: "high", reasoningBudget: { mode: "tokens", tokens: 512 } });
  });

  test("an empty calibrated map disables inherited mappings and can return to inheritance", () => {
    const harness = configReasoningHarness({ calibration: { response: { generation: {} } } });
    harness.file.config.generation.reasoningBudgetByMode = { fast: 32 };
    const calibratedPath = ["calibration", "response", "generation", "reasoningBudgetByMode"];
    expect(harness.resolve(true)).toMatchObject({ reasoningBudget: { mode: "tokens", tokens: 32 } });
    harness.field(calibratedPath, "custom", "reasoning-mode-budgets");
    expect(harness.file.config.calibration.response.generation.reasoningBudgetByMode).toEqual({});
    expect(harness.resolve(true)).toMatchObject({ think: "none" });
    expect(harness.resolve(true).reasoningBudget).toBeUndefined();
    harness.field(calibratedPath, "inherit", "reasoning-mode-budgets");
    expect(harness.resolve(true)).toMatchObject({ reasoningBudget: { mode: "tokens", tokens: 32 } });
  });

  test.each(["openai", "ollama"])("%s exposes only removal of an existing unsupported map", (provider) => {
    const harness = configReasoningHarness({ provider });
    expect(harness.render()).not.toContain("Mode token overrides");
    harness.file.config.generation.reasoningBudgetByMode = { fast: 32 };
    expect(harness.render()).toContain("Saved override (unsupported target)");
    expect(harness.render()).not.toContain("Low thinking tokens");
    harness.field(mapPath, "inherit", "reasoning-mode-budgets");
    expect(harness.file.config.generation.reasoningBudgetByMode).toBeUndefined();
  });
});
