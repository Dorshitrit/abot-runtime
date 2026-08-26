import type { ModelTokenEstimationConfig } from "../../../../model-gateway/types.js";
import { estimateMessageTokens } from "../../token-estimator.js";
import {
  resolveRequestBudgetInputTokens,
  type RequestMessagesBudgetAssessment,
} from "../../request-context-budget.js";
import {
  STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS,
  buildStructuredModelRepairHint,
} from "../../../model/repair-prompts.js";

export function hasSessionMemoryRepairHeadroom(params: {
  assessment: RequestMessagesBudgetAssessment;
  tokenEstimation?: ModelTokenEstimationConfig;
}): boolean {
  const repairMessageTokens = estimateMessageTokens(
    {
      role: "system",
      content: buildStructuredModelRepairHint({
        repairAttempt: STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS,
        stage: "session_memory_compaction",
        issues: Object.freeze([
          Object.freeze({
            code: "session_memory_summary_invalid",
            path: "summary",
            message: "Return one bounded replacement summary.",
          }),
        ]),
        repeatedInvalidOutput: true,
      }),
    },
    params.tokenEstimation,
  );
  const inputTokens = resolveRequestBudgetInputTokens(params.assessment.budget);
  return (
    params.assessment.fits &&
    inputTokens + repairMessageTokens <=
      params.assessment.budget.availableInputTokens
  );
}
