import { isRegisteredModelStepInLane } from "../../shared/model-step-registry.js";
import type { ModelReasoningBudget } from "../../shared/model-reasoning.js";
import type {
  ModelReasoningBudgetByMode,
  ReasoningBudgetMode,
} from "../../shared/model-reasoning-modes.js";
import type { ModelGatewayRequest } from "../types.js";

/** Conversation presets never replace a utility step's calibrated budget. */
export function resolveReasoningModeBudget(
  request: ModelGatewayRequest,
  mapping: ModelReasoningBudgetByMode | undefined,
): ModelReasoningBudget | undefined {
  if (!mapping) return undefined;
  if (
    request.modelStep !== undefined &&
    !isRegisteredModelStepInLane(request.modelStep, "main")
  )
    return undefined;
  const mode = String(request.agentMode || "reasoning").toLowerCase();
  if (!Object.hasOwn(mapping, mode)) return undefined;
  return { mode: "tokens", tokens: mapping[mode as ReasoningBudgetMode]! };
}
