import {
  isFiniteReasoningBudgetTokens,
  ModelReasoningConfigurationError,
} from "./model-reasoning.js";

export const REASONING_BUDGET_MODES = ["fast", "reasoning", "deep"] as const;
export type ReasoningBudgetMode = (typeof REASONING_BUDGET_MODES)[number];

/** Sparse whole-map override; omission inherits and an empty map clears it. */
export type ModelReasoningBudgetByMode = Readonly<
  Partial<Record<ReasoningBudgetMode, number>>
>;

export function parseModelReasoningBudgetByMode(
  value: unknown,
): ModelReasoningBudgetByMode | undefined {
  if (value === undefined) return undefined;
  const fail = (): never => {
    throw new ModelReasoningConfigurationError(
      "invalid_reasoning_budget_by_mode",
      "expected fast, reasoning or deep with non-negative 32-bit token budgets",
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const result: Partial<Record<ReasoningBudgetMode, number>> = {};
  for (const [key, tokens] of Object.entries(value)) {
    if (!REASONING_BUDGET_MODES.includes(key as ReasoningBudgetMode))
      return fail();
    if (!isFiniteReasoningBudgetTokens(tokens)) return fail();
    result[key as ReasoningBudgetMode] = tokens;
  }
  return Object.freeze(result);
}
