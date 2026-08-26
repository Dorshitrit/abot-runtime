import type {
  ChatMessage,
  ModelTokenEstimationConfig,
} from "../../../model-gateway/types.js";
import {
  STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS,
  buildStructuredModelRepairHint,
} from "../../model/repair-prompts.js";
import {
  resolveRequestBudgetInputTokens,
  type RequestMessagesBudgetAssessment,
} from "../request-context-budget.js";
import { estimateMessageTokens } from "../token-estimator.js";
import { SEMANTIC_COMPACTION_PARSE_ISSUE_CODES } from "./parser.js";

export type SemanticCompactionRepairValidation = Readonly<{
  stage: "semantic_compaction" | "semantic_compaction_slice";
  path: "checkpoint";
  message: string;
}>;

export const SEMANTIC_COMPACTION_BATCH_VALIDATION = Object.freeze({
  stage: "semantic_compaction" as const,
  path: "checkpoint" as const,
  message:
    "Return one valid replacement continuation and one semantic digest for every supplied source, in input order.",
});

export const SEMANTIC_COMPACTION_SLICE_VALIDATION = Object.freeze({
  stage: "semantic_compaction_slice" as const,
  path: "checkpoint" as const,
  message:
    "Return one cumulative continuation and semantic digest for the supplied source.",
});

export type SemanticCompactionRepairHeadroom = Readonly<{
  fits: boolean;
  repairReserveTokens: number;
}>;

/**
 * Reserves input capacity for the largest repair envelope that the semantic
 * compaction parser can produce. Provider input counting remains unchanged;
 * only the additional bounded repair message is estimated locally.
 */
export function assessSemanticCompactionRepairHeadroom(params: {
  assessment: RequestMessagesBudgetAssessment;
  tokenEstimation?: ModelTokenEstimationConfig;
  validation: SemanticCompactionRepairValidation;
}): SemanticCompactionRepairHeadroom {
  const repairMessage = createRepairReserveMessage(params.validation);
  const repairReserveTokens = estimateMessageTokens(
    repairMessage,
    params.tokenEstimation,
  );
  const inputTokens = resolveRequestBudgetInputTokens(
    params.assessment.budget,
  );
  return Object.freeze({
    fits:
      params.assessment.fits &&
      inputTokens + repairReserveTokens <=
        params.assessment.budget.availableInputTokens,
    repairReserveTokens,
  });
}

function createRepairReserveMessage(
  validation: SemanticCompactionRepairValidation,
): ChatMessage {
  return Object.freeze({
    role: "system" as const,
    content: buildStructuredModelRepairHint({
      repairAttempt: STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS,
      stage: validation.stage,
      issues: Object.freeze([
        Object.freeze({
          code: longestSemanticCompactionIssueCode(),
          path: validation.path,
          message: validation.message,
        }),
      ]),
      repeatedInvalidOutput: true,
    }),
  });
}

function longestSemanticCompactionIssueCode(): string {
  return SEMANTIC_COMPACTION_PARSE_ISSUE_CODES.reduce(
    (longest, candidate) =>
      candidate.length > longest.length ? candidate : longest,
    "",
  );
}
