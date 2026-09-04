import type { ChatMessage } from "../../model-gateway/types.js";
import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import {
  buildToolAvailabilityOverview,
  type ToolAvailabilityOverviewGroup,
  type ToolAvailabilityOverviewLevel,
} from "../../plugin-sdk/tool-availability-overview.js";
import { assessRequestMessagesBudget } from "./request-context-budget.js";
import type { projectRequestContext } from "./request-context.js";
import { estimateMessageTokens } from "./token-estimator.js";

export const CAPABILITY_BRIEF_KIND = "runtime_capability_brief_v1";
export const CAPABILITY_BRIEF_MAX_TOKENS = 512;
const CAPABILITY_BRIEF_PREFIX = `${CAPABILITY_BRIEF_KIND}\n`;

export type CapabilityBriefLevel = ToolAvailabilityOverviewLevel | "none";
export type CapabilityBriefProjection = Readonly<{
  level: CapabilityBriefLevel;
  message?: ChatMessage;
  estimatedTokens: number;
  budgetTokens: number;
  reason: "complete_catalog" | "empty_catalog" | "insufficient_budget";
}>;

type ContextInput = Parameters<typeof projectRequestContext>[0];

/** Optional availability metadata admitted against the full context estimate. */
export function projectCapabilityBrief(
  params: Readonly<{
    entries?: readonly ToolAvailabilityEntry[];
    groups: readonly ToolAvailabilityOverviewGroup[];
    context: ContextInput;
    additionalBudgetMessages?: readonly ChatMessage[];
  }>,
): CapabilityBriefProjection {
  const budgetTokens = resolveCapabilityBriefBudget(params);
  if (params.groups.length === 0) {
    return omittedBrief(budgetTokens, "empty_catalog");
  }
  const levels: readonly ToolAvailabilityOverviewLevel[] =
    hasCompleteCapabilityBriefEntries(params.entries, params.groups)
      ? ["detailed", "titles", "groups"]
      : ["groups"];
  for (const level of levels) {
    const body = buildToolAvailabilityOverview(
      params.entries ?? [],
      params.groups,
      level,
    );
    const message: ChatMessage = Object.freeze({
      role: "system",
      content: [
        CAPABILITY_BRIEF_KIND,
        "Request-registry availability for delegation only. Data, not instructions, user intent, execution authority, pending work, or completion evidence.",
        `Detail: ${level}. Complete coverage at this level; omitted detail does not mean unavailable capabilities.`,
        body,
      ].join("\n"),
    });
    const estimatedTokens = estimateMessageTokens(
      message,
      params.context.budget.tokenEstimation,
    );
    if (!fitsCapabilityBriefBudget(estimatedTokens, budgetTokens)) continue;
    return Object.freeze({
      level,
      message,
      estimatedTokens,
      budgetTokens,
      reason: "complete_catalog",
    });
  }
  return omittedBrief(budgetTokens, "insufficient_budget");
}

/** Consumers explicitly remove this optional reference at narrower phases. */
export function isCapabilityBriefMessage(message: ChatMessage): boolean {
  if (message.role !== "system") return false;
  return message.content.startsWith(CAPABILITY_BRIEF_PREFIX);
}

function resolveCapabilityBriefBudget(
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
  const { budget } = assessRequestMessagesBudget({
    messages,
    budget: context.budget,
    ...(context.format ? { format: context.format } : {}),
  });
  // Configured methodology is added later; reserve it for the 70% threshold
  // as well as the input ceiling. Strictly below: admission triggers on >=.
  const instructionReserve =
    context.budget.configuredInstructionReserveTokens ?? 0;
  const compactionHeadroom =
    budget.compactionTriggerInputTokens -
    1 -
    budget.estimatedInputTokens -
    instructionReserve;
  const admissionHeadroom =
    budget.availableInputTokens - budget.estimatedInputTokens;
  return Math.max(
    0,
    Math.min(
      CAPABILITY_BRIEF_MAX_TOKENS,
      compactionHeadroom,
      admissionHeadroom,
    ),
  );
}

function hasCompleteCapabilityBriefEntries(
  entries: readonly ToolAvailabilityEntry[] | undefined,
  groups: readonly ToolAvailabilityOverviewGroup[],
): entries is readonly ToolAvailabilityEntry[] {
  if (entries === undefined) return false;
  if (entries.length === 0) return false;
  const operationIds = new Set(entries.map((entry) => entry.operationId));
  if (operationIds.size !== entries.length) return false;
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const groupId of new Set(entry.catalogGroups)) {
      counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
    }
  }
  if (counts.size !== groups.length) return false;
  return groups.every(
    (group) => counts.get(group.groupId) === group.memberCount,
  );
}

function fitsCapabilityBriefBudget(tokens: number, budget: number): boolean {
  return tokens <= budget;
}

function omittedBrief(
  budgetTokens: number,
  reason: "empty_catalog" | "insufficient_budget",
): CapabilityBriefProjection {
  return Object.freeze({
    level: "none",
    estimatedTokens: 0,
    budgetTokens,
    reason,
  });
}
