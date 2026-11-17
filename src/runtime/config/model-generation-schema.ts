import { MODEL_PARAMETER_DEFINITIONS } from "../../shared/model-parameter-validation.js";
import type { ModelParameterDefinition } from "../../shared/model-parameters.js";
import {
  modelReasoningBudgetByModeSchema,
  modelReasoningBudgetSchema,
} from "./model-reasoning-schema.js";

function parameterValueSchema(
  definition: ModelParameterDefinition,
): Record<string, unknown> {
  if (definition.type === "enum") return { enum: definition.values };
  if (definition.type === "bool") return { type: "boolean" };
  return {
    type: definition.type === "int" ? "integer" : "number",
    ...(definition.min !== undefined ? { minimum: definition.min } : {}),
    ...(definition.max !== undefined ? { maximum: definition.max } : {}),
  };
}

function parameterControlSchema(
  definition: ModelParameterDefinition,
): Record<string, unknown> {
  return {
    description: definition.description,
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["mode"],
        properties: { mode: { enum: ["omit", "inherit"] } },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["mode", "value"],
        properties: {
          mode: { const: "value" },
          value: parameterValueSchema(definition),
        },
      },
    ],
  };
}

export function modelGenerationSchema(): Record<string, unknown> {
  return {
    type: "object",
    description: "Generation settings for a model profile.",
    properties: {
      parameters: {
        type: "object",
        additionalProperties: false,
        description:
          "Canonical controls: omit sends no field, inherit resolves lower layers, value applies an explicit value.",
        properties: Object.fromEntries(
          MODEL_PARAMETER_DEFINITIONS.map((definition) => [
            definition.key,
            parameterControlSchema(definition),
          ]),
        ),
      },
      temperature: {
        type: "number",
        description:
          "Legacy sampling temperature; canonical parameters.temperature takes precedence in the same layer.",
      },
      topP: {
        type: "number",
        description:
          "Legacy nucleus sampling value; canonical parameters.top_p takes precedence in the same layer.",
      },
      reasoningBudget: modelReasoningBudgetSchema,
      reasoningBudgetByMode: modelReasoningBudgetByModeSchema,
      reasoningEffort: {
        type: "string",
        enum: ["none", "minimal", "low", "medium", "high", "xhigh"],
        description:
          "Legacy reasoning effort; canonical parameters.reasoning_effort takes precedence in the same layer.",
      },
    },
  };
}
