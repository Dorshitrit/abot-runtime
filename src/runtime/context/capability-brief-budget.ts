import type { ChatMessage } from "../../model-gateway/types.js";
import { assessRequestMessagesBudget } from "./request-context-budget.js";
import type { RequestContextBudget } from "./request-context-contracts.js";
import type { projectRequestContext } from "./request-context.js";

type ContextInput = Parameters<typeof projectRequestContext>[0];

/** Headroom for one passive brief without evicting existing request context. */
export function resolveCapabilityBriefHeadroom(
  params: Readonly<{
    context: ContextInput;
    additionalBudgetMessages?: readonly ChatMessage[];
  }>,
): number {
  const { context } = params;
  const messages: ChatMessage[] = [
    { role: "system", content: context.instructions },
    ...(context.priorConversationMessages ?? []),
    ...context.historyMessages,
    ...(context.referenceMessages ?? []),
    ...(context.referenceParts?.flatMap((part) => part.messages) ?? []),
    ...(context.continuationMessages ?? []),
    ...(context.continuationParts?.flatMap((part) => part.messages) ?? []),
    {
      role: "user",
      content: context.prompt,
      ...(context.attachments ? { attachments: context.attachments } : {}),
    },
    ...(params.additionalBudgetMessages ?? []),
  ];
  return resolveCapabilityBriefMessageHeadroom({
    messages,
    budget: context.budget,
    ...(context.format ? { format: context.format } : {}),
  });
}

/** Computes capacity from concrete messages plus any not-yet-added reserves. */
export function resolveCapabilityBriefMessageHeadroom(
  params: Readonly<{
    messages: readonly ChatMessage[];
    budget: RequestContextBudget;
    format?: Readonly<{ schema: unknown }>;
  }>,
): number {
  const { budget } = assessRequestMessagesBudget(params);
  // Reserve instructions not yet inserted against both the 70% threshold
  // and the input ceiling. Strictly below: admission triggers on >=.
  const instructionReserve =
    params.budget.configuredInstructionReserveTokens ?? 0;
  const compactionHeadroom =
    budget.compactionTriggerInputTokens -
    1 -
    budget.estimatedInputTokens -
    instructionReserve;
  const admissionHeadroom =
    budget.availableInputTokens - budget.estimatedInputTokens;
  return Math.max(0, Math.min(compactionHeadroom, admissionHeadroom));
}
