import { describe, expect, test } from "vitest";

import { assessRequestMessagesBudget } from "../context/request-context-budget.js";

const BUDGET = Object.freeze({
  contextWindowTokens: 16_000,
  outputReserveTokens: 2_048,
  safetyReserveTokens: 500,
  attachmentReserveTokens: 100,
});

describe("measured request context budget", () => {
  test("rejects input when the provider count exceeds the safe input budget", () => {
    const assessment = assessRequestMessagesBudget({
      messages: [{ role: "user", content: "A deceptively small estimate." }],
      budget: BUDGET,
      measuredInputTokens: 14_000,
    });

    expect(assessment.fits).toBe(false);
    expect(assessment.budget.availableInputTokens).toBe(13_452);
    expect(assessment.budget.measuredInputTokens).toBe(14_000);
    expect(assessment.budget.estimatedInputTokens).toBeLessThan(14_000);
    expect(assessment.budget.remainingContextTokens).toBe(2_000);
    expect(assessment.budget.usedContextPercent).toBe(87.5);
  });

  test("uses a smaller provider count while retaining the estimate for diagnostics", () => {
    const assessment = assessRequestMessagesBudget({
      messages: [{ role: "user", content: "x".repeat(60_000) }],
      budget: BUDGET,
      measuredInputTokens: 10_000,
    });

    expect(assessment.budget.estimatedInputTokens).toBeGreaterThan(13_452);
    expect(assessment.budget.measuredInputTokens).toBe(10_000);
    expect(assessment.fits).toBe(true);
    expect(assessment.budget.remainingContextTokens).toBe(6_000);
  });
});
