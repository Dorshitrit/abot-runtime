import type { ModelStep } from "../../shared/model-steps.js";
import type { RequestContextBudget } from "../context/request-context-contracts.js";

/** Only the EA main decision and response add a soft-trigger override. */
export function resolveModelStepCompactionPolicy(
  modelStep: ModelStep,
): Pick<RequestContextBudget, "compactionTriggerRatio"> {
  if (modelStep === "execution.decision") return { compactionTriggerRatio: 0.9 };
  if (modelStep === "execution.response") return { compactionTriggerRatio: 0.9 };
  return {};
}
