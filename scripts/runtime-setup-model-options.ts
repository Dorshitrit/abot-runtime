import {
  parseModelReasoningBudget,
  type ModelReasoningBudget,
} from "../src/shared/model-reasoning.js";

export type SetupModelOptions = Readonly<{
  supportsThinking?: boolean;
  reasoningBudget?: ModelReasoningBudget;
}>;

export function parseSetupModelOptions(body: Record<string, unknown>): SetupModelOptions {
  const supportsThinking = body.supportsThinking;
  if (supportsThinking !== undefined && typeof supportsThinking !== "boolean")
    throw new Error("Supports reasoning must be true or false.");
  const reasoningBudget = parseModelReasoningBudget(body.reasoningBudget);
  if (reasoningBudget !== undefined && supportsThinking !== true)
    throw new Error("Enable reasoning support before configuring its budget.");
  return {
    ...(supportsThinking !== undefined ? { supportsThinking } : {}),
    ...(reasoningBudget !== undefined ? { reasoningBudget } : {}),
  };
}

export function parseCliReasoningBudget(value: string): ModelReasoningBudget {
  const hasReasoningBudgetInput = value.trim().length > 0;
  if (!hasReasoningBudgetInput) throw new Error("A reasoning budget is required.");
  if (value === "server-default") return { mode: "server-default" };
  const budget = parseModelReasoningBudget({ mode: "tokens", tokens: Number(value) });
  if (!budget) throw new Error("A reasoning budget is required.");
  return budget;
}

export function buildSetupModelReasoning(
  provider: string,
  generation: Record<string, unknown>,
  options: SetupModelOptions,
): Record<string, unknown> {
  const validated = parseSetupModelOptions(options);
  if (validated.reasoningBudget && provider !== "llamacpp")
    throw new Error("A token reasoning budget requires a llama.cpp provider.");
  if (provider !== "llamacpp") return validated.supportsThinking === undefined
    ? {}
    : { supportsThinking: validated.supportsThinking };
  return {
    supportsThinking: validated.supportsThinking === true,
    capabilities: { inputModalities: ["text"] },
    ...(validated.reasoningBudget
      ? { generation: { ...generation, reasoningBudget: validated.reasoningBudget } }
      : {}),
  };
}
