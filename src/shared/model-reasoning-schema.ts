import { MAX_REASONING_BUDGET_TOKENS } from "./model-reasoning.js";

/** Structured authoring uses the same optional, profile-bound request contract. */
export const modelReasoningPreferenceSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["profileId", "mode", "budgetTokens"],
      properties: {
        profileId: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["budget"] },
        budgetTokens: {
          type: "integer",
          minimum: 0,
          maximum: MAX_REASONING_BUDGET_TOKENS,
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["profileId", "mode"],
      properties: {
        profileId: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["off", "server-default"] },
      },
    },
  ],
};
