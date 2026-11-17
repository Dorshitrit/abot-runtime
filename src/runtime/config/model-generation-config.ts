import type { ModelGenerationConfig } from "../../model-gateway/types.js";
import { parseModelParameterControls } from "../../shared/model-parameter-validation.js";
import { parseModelReasoningBudgetByMode } from "../../shared/model-reasoning-modes.js";
import { parseModelReasoningBudget } from "../../shared/model-reasoning.js";
import { isRecord } from "./utils.js";

function readGenerationNumber(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function readLegacyReasoningEffort(
  value: unknown,
): ModelGenerationConfig["reasoningEffort"] {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  )
    return value;
  return undefined;
}

export function buildModelGenerationConfig(
  value: unknown,
): ModelGenerationConfig | undefined {
  if (!isRecord(value)) return undefined;
  const parameters = parseModelParameterControls(value.parameters);
  const reasoningBudget = parseModelReasoningBudget(value.reasoningBudget);
  const reasoningBudgetByMode = parseModelReasoningBudgetByMode(
    value.reasoningBudgetByMode,
  );
  const temperature = readGenerationNumber(value, "temperature");
  const topP = readGenerationNumber(value, "topP");
  const reasoningEffort = readLegacyReasoningEffort(value.reasoningEffort);
  const config: ModelGenerationConfig = {
    ...(parameters ? { parameters } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(reasoningBudget ? { reasoningBudget } : {}),
    ...(reasoningBudgetByMode ? { reasoningBudgetByMode } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}
