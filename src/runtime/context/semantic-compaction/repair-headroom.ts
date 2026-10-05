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
    "Return one valid source-scoped replacement continuation and a sourceDigests object with exactly one semantic digest under each supplied sourceKey.",
});

export const SEMANTIC_COMPACTION_SLICE_VALIDATION = Object.freeze({
  stage: "semantic_compaction_slice" as const,
  path: "checkpoint" as const,
  message:
    "Return one cumulative source-scoped continuation and a sourceDigests object with the cumulative semantic digest under the supplied sourceKey.",
});

export type SemanticCompactionRepairHeadroom = Readonly<{
  fits: boolean;
  repairReserveTokens: number;
}>;

export function buildSemanticCompactionTokenBudgetIssue(
  inputTokens: number,
  allowance: number,
): string {
  return `The projected checkpoint uses ${inputTokens} input tokens; its budget is ${allowance}. Shorten sourceDigests and continuation together to fit this shared token budget, including source-reference metadata. Keep required source keys and task-relevant facts.`;
}

/**
 * Reserves input capacity for the largest repair envelope that the semantic
 * compaction validation can produce. Provider input counting remains unchanged;
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
  const inputTokens = resolveRequestBudgetInputTokens(params.assessment.budget);
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
          message: [
            validation.message,
            buildSemanticCompactionTokenBudgetIssue(
              Number.MAX_SAFE_INTEGER,
              Number.MAX_SAFE_INTEGER,
            ),
          ].join(" "),
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
