import { describe, expect, test } from "vitest";
import {
  parseModelReasoningBudget,
  parseModelReasoningPreference,
  parseBoundModelReasoningPreference,
} from "./model-reasoning.js";

describe("reasoning input boundary", () => {
  test.each([-1, 1.5, Infinity, NaN, 2147483648, "512", null])(
    "rejects finite token input %s",
    (tokens) => {
      expect(() =>
        parseModelReasoningBudget({ mode: "tokens", tokens }),
      ).toThrow("invalid_reasoning_budget");
      expect(() =>
        parseModelReasoningPreference({
          profileId: "gemma",
          mode: "budget",
          budgetTokens: tokens,
        }),
      ).toThrow("invalid_reasoning_preference");
    },
  );
  test("zero is retained as an explicit disabled budget, distinct from inheritance", () => {
    expect(parseModelReasoningBudget({ mode: "tokens", tokens: 0 })).toEqual({
      mode: "tokens", tokens: 0,
    });
    expect(parseModelReasoningPreference({ profileId: "gemma", mode: "budget", budgetTokens: 0 })).toEqual({
      profileId: "gemma", mode: "budget", budgetTokens: 0,
    });
  });
  test("inherit is absence, with no native sentinel exposed", () => {
    expect(parseModelReasoningBudget(undefined)).toBeUndefined();
    expect(parseModelReasoningPreference(undefined)).toBeUndefined();
    expect(parseModelReasoningBudget({ mode: "server-default" })).toEqual({
      mode: "server-default",
    });
    expect(() => parseModelReasoningPreference(null)).toThrow();
    expect(() =>
      parseModelReasoningBudget({ mode: "server-default", tokens: 512 }),
    ).toThrow();
    expect(() =>
      parseModelReasoningPreference({
        profileId: "gemma",
        mode: "off",
        budgetTokens: 512,
      }),
    ).toThrow();
  });
  test("captured values cannot be mutated or rebound", () => {
    const input = { profileId: "gemma", mode: "budget", budgetTokens: 512 };
    const captured = parseBoundModelReasoningPreference(input, "gemma");
    input.budgetTokens = 2048;
    expect(captured).toEqual({
      profileId: "gemma",
      mode: "budget",
      budgetTokens: 512,
    });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(() => parseBoundModelReasoningPreference(input, "other")).toThrow(
      "profile_mismatch",
    );
  });
});
