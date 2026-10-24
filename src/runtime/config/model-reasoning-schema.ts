import { MAX_REASONING_BUDGET_TOKENS } from "../../shared/model-reasoning.js";

export const modelReasoningBudgetSchema = {
  description:
    "Reasoning-only budget for a declared budget-capable model. Zero disables thinking. Omit to inherit.",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "tokens"],
      properties: {
        mode: { const: "tokens" },
        tokens: {
          type: "integer",
          minimum: 0,
          maximum: MAX_REASONING_BUDGET_TOKENS,
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: { mode: { const: "server-default" } },
    },
  ],
};

export const modelReasoningBudgetByModeSchema = {
  type: "object",
  description:
    "Optional llama.cpp token budgets for main-step Low/Reasoning/Deep presets. Omit to inherit; {} clears the inherited map. A provided map replaces the whole parent map. Zero disables thinking; positive mode budgets enable it.",
  additionalProperties: false,
  properties: Object.fromEntries(
    ["fast", "reasoning", "deep"].map((mode) => [
      mode,
      {
        type: "integer",
        minimum: 0,
        maximum: MAX_REASONING_BUDGET_TOKENS,
      },
    ]),
  ),
};
