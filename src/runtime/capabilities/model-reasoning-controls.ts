import type { ToolNormalInvocationPropertyInput } from "../../capabilities/normal-invocation/contracts.js";
import {
  MAX_REASONING_BUDGET_TOKENS,
  ModelReasoningConfigurationError,
  parseModelReasoningPreference,
  type ModelReasoningPreference,
} from "../../shared/model-reasoning.js";

/** Flat v1 tool inputs project to the canonical nested Runtime request contract. */
export const modelReasoningControlProperties = {
  reasoningMode: {
    type: "string",
    enum: ["inherit", "off", "budget", "server-default"],
  },
  reasoningBudgetTokens: {
    type: "integer",
    minimum: 0,
    maximum: MAX_REASONING_BUDGET_TOKENS,
  },
} satisfies Record<string, ToolNormalInvocationPropertyInput>;

function hasUnboundReasoningTokenControl(
  params: Readonly<Record<string, unknown>>,
): boolean {
  if (params.reasoningBudgetTokens === undefined) return false;
  return params.reasoningMode !== "budget";
}

export function readModelReasoningControlPatch(
  params: Readonly<Record<string, unknown>>,
  profileId: unknown,
): { reasoningPreference?: ModelReasoningPreference | null } {
  if (hasUnboundReasoningTokenControl(params))
    throw new ModelReasoningConfigurationError(
      "invalid_reasoning_preference",
      "reasoningBudgetTokens requires reasoningMode=budget",
    );
  if (params.reasoningMode === undefined) return {};
  if (params.reasoningMode === "inherit") return { reasoningPreference: null };
  const preference = parseModelReasoningPreference({
    profileId,
    mode: params.reasoningMode,
    ...(params.reasoningBudgetTokens !== undefined
      ? { budgetTokens: params.reasoningBudgetTokens }
      : {}),
  });
  return { reasoningPreference: preference };
}

function hasChangedReasoningModelProfile(previousProfileId: unknown, nextProfileId: unknown): boolean {
  if (typeof previousProfileId !== "string") return false;
  if (typeof nextProfileId !== "string") return false;
  return previousProfileId !== nextProfileId;
}

/** Tool model switches inherit the new profile unless controls are explicit. */
export function readUpdatedModelReasoningControls(
  params: Readonly<Record<string, unknown>>,
  previousProfileId: unknown,
  nextProfileId: unknown,
): { reasoningPreference?: ModelReasoningPreference | null } {
  const patch = readModelReasoningControlPatch(params, nextProfileId);
  if ("reasoningPreference" in patch) return patch;
  if (!hasChangedReasoningModelProfile(previousProfileId, nextProfileId)) return patch;
  return { reasoningPreference: null };
}

export function readCreatedModelReasoningControls(
  params: Readonly<Record<string, unknown>>,
  profileId: unknown,
): { reasoningPreference?: ModelReasoningPreference } {
  const patch = readModelReasoningControlPatch(params, profileId);
  if (!patch.reasoningPreference) return {};
  return { reasoningPreference: patch.reasoningPreference };
}
