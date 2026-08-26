import type { ChatMessage } from "../../model-gateway/types.js";
import type {
  RequestContextBudget,
  RequestContextBudgetEstimate,
} from "./request-context-contracts.js";
import {
  estimateMessagesTokens,
  estimateTextTokens,
} from "./token-estimator.js";

export type RequestMessagesBudgetAssessment = Readonly<{
  fits: boolean;
  budget: RequestContextBudgetEstimate;
}>;

export const CONTEXT_COMPACTION_TRIGGER_RATIO = 0.7;

export function resolveContextCompactionTriggerInputTokens(
  contextWindowTokens: number,
): number {
  return Math.ceil(contextWindowTokens * CONTEXT_COMPACTION_TRIGGER_RATIO);
}

export function assessRequestMessagesBudget(params: {
  messages: readonly ChatMessage[];
  format?: Readonly<{ schema: unknown }>;
  budget: RequestContextBudget;
  measuredInputTokens?: number;
}): RequestMessagesBudgetAssessment {
  const formatTokenAccounting = params.budget.formatTokenAccounting;
  const formatReserveTokens =
    params.format && formatTokenAccounting?.mode !== "none"
      ? estimateTextTokens(
          JSON.stringify(params.format.schema),
          params.budget.tokenEstimation,
        ) + (formatTokenAccounting?.fixedOverheadTokens ?? 0)
      : 0;
  const attachmentCount = params.messages.reduce(
    (total, message) => total + (message.attachments?.length ?? 0),
    0,
  );
  const attachmentReserveTokens =
    attachmentCount * params.budget.attachmentReserveTokens;
  const configuredInstructionReserveTokens =
    params.budget.configuredInstructionReserveTokens ?? 0;
  const availableInputTokens =
    params.budget.contextWindowTokens -
    params.budget.outputReserveTokens -
    params.budget.safetyReserveTokens -
    configuredInstructionReserveTokens;
  const estimatedInputTokens =
    estimateMessagesTokens(params.messages, params.budget.tokenEstimation) +
    attachmentReserveTokens +
    formatReserveTokens;
  const measuredInputTokens = params.measuredInputTokens;
  if (
    measuredInputTokens !== undefined &&
    (!Number.isSafeInteger(measuredInputTokens) || measuredInputTokens < 0)
  ) {
    throw new TypeError("request_context_measured_input_tokens_invalid");
  }
  const assessedInputTokens = measuredInputTokens ?? estimatedInputTokens;
  const remainingContextTokens = Math.max(
    0,
    params.budget.contextWindowTokens - assessedInputTokens,
  );
  const usedContextPercent =
    Math.round(
      (assessedInputTokens / params.budget.contextWindowTokens) * 1_000,
    ) / 10;
  return Object.freeze({
    fits:
      availableInputTokens > 0 && assessedInputTokens <= availableInputTokens,
    budget: Object.freeze({
      contextWindowTokens: params.budget.contextWindowTokens,
      availableInputTokens,
      outputReserveTokens: params.budget.outputReserveTokens,
      safetyReserveTokens: params.budget.safetyReserveTokens,
      ...(configuredInstructionReserveTokens > 0
        ? { configuredInstructionReserveTokens }
        : {}),
      formatReserveTokens,
      attachmentReserveTokens,
      estimatedInputTokens,
      ...(measuredInputTokens !== undefined ? { measuredInputTokens } : {}),
      remainingContextTokens,
      usedContextPercent,
      compactionTriggerInputTokens: resolveContextCompactionTriggerInputTokens(
        params.budget.contextWindowTokens,
      ),
    }),
  });
}

export function resolveRequestBudgetInputTokens(
  budget: Pick<
    RequestContextBudgetEstimate,
    "estimatedInputTokens" | "measuredInputTokens"
  >,
): number {
  return budget.measuredInputTokens ?? budget.estimatedInputTokens;
}
