import type {
  ChatMessage,
  ModelGatewayAttachment,
  ModelGatewayJsonSchemaFormat,
} from "../../model-gateway/types.js";
import type {
  RequestContextBudget,
  RequestContextBudgetEstimate,
  RequestContextBudgetParts,
  RequestContextPinnedPart,
  RequestContextProjection,
  RequestHistoryMessage,
} from "./request-context-contracts.js";
import { traceDebug } from "../observability/debug-logger.js";
import { projectPinnedContext } from "./pinned-context-compaction.js";
import { assessRequestMessagesBudget } from "./request-context-budget.js";
import { estimateMessagesTokens } from "./token-estimator.js";

type ConversationTurn = {
  source: RequestHistoryMessage[];
  messages: ChatMessage[];
};

type RequestContextDiagnostic = Readonly<{
  requestId: string;
  modelStep: string;
  callId?: string;
}>;

export { assessRequestMessagesBudget } from "./request-context-budget.js";
export type { RequestMessagesBudgetAssessment } from "./request-context-budget.js";

export function projectRequestContext(params: {
  instructions: string;
  format?: ModelGatewayJsonSchemaFormat;
  historyMessages: readonly RequestHistoryMessage[];
  prompt: string;
  currentMessagePlacement?: "before_continuation" | "after_continuation";
  attachments?: ModelGatewayAttachment[];
  priorConversationMessages?: readonly ChatMessage[];
  referenceMessages?: readonly ChatMessage[];
  continuationMessages?: readonly ChatMessage[];
  referenceParts?: readonly RequestContextPinnedPart[];
  continuationParts?: readonly RequestContextPinnedPart[];
  budget: RequestContextBudget;
  diagnostic?: RequestContextDiagnostic;
  onEvent?: (name: string, extra?: Record<string, unknown>) => void;
  /** Allows the shared model-step admission gate to compact before dispatch. */
  deferCompactionFailure?: boolean;
  historyRetention?: "compaction_managed";
}): RequestContextProjection {
  const attachments = params.attachments ?? [];
  const priorConversationMessages = params.priorConversationMessages ?? [];
  const referenceParts = resolvePinnedParts({
    category: "request_reference",
    legacyMessages: params.referenceMessages,
    parts: params.referenceParts,
  });
  const continuationParts = resolvePinnedParts({
    category: "role_continuation",
    legacyMessages: params.continuationMessages,
    parts: params.continuationParts,
  });
  const fixedMessages: ChatMessage[] = [
    { role: "system", content: params.instructions },
    ...priorConversationMessages,
  ];
  const currentMessage: ChatMessage = {
    role: "user",
    content: params.prompt,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
  const pinnedProjection = projectPinnedContext({
    fixedMessages,
    currentMessage,
    ...(params.currentMessagePlacement
      ? { currentMessagePlacement: params.currentMessagePlacement }
      : {}),
    referenceParts,
    continuationParts,
    ...(params.format ? { format: params.format } : {}),
    budget: params.budget,
    ...(params.diagnostic ? { diagnostic: params.diagnostic } : {}),
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
    ...(params.deferCompactionFailure
      ? { deferLifecycleToModelStep: true }
      : {}),
  });
  const referenceMessages = pinnedProjection.referenceMessages;
  const continuationMessages = pinnedProjection.continuationMessages;
  const pinnedAssessment = pinnedProjection.assessment;
  const availableInputTokens =
    pinnedAssessment.budget.availableInputTokens;
  const pinnedTokenEstimate =
    pinnedAssessment.budget.estimatedInputTokens;
  const baseParts: RequestContextBudgetParts = Object.freeze({
    instructionInputTokens: estimateMessagesTokens(
      fixedMessages.slice(0, 1),
      params.budget.tokenEstimation,
    ),
    priorConversationInputTokens: estimateMessagesTokens(
      priorConversationMessages,
      params.budget.tokenEstimation,
    ),
    referenceInputTokens: estimateMessagesTokens(
      referenceMessages,
      params.budget.tokenEstimation,
    ),
    currentPromptInputTokens: estimateMessagesTokens(
      [currentMessage],
      params.budget.tokenEstimation,
    ),
    continuationInputTokens: estimateMessagesTokens(
      continuationMessages,
      params.budget.tokenEstimation,
    ),
    selectedHistoryInputTokens: 0,
    pinnedInputTokens: pinnedTokenEstimate,
  });

  if (!pinnedAssessment.fits) {
    traceRequestContextBudgetAssessment({
      diagnostic: params.diagnostic,
      outcome: "rejected",
      issueCode:
        pinnedProjection.errorCode ===
        "request_context_required_content_exceeds_budget"
          ? "required_content_exceeds_budget"
          : "pinned_content_exceeds_budget",
      budget: pinnedAssessment.budget,
      parts: baseParts,
      historyMessageCount: params.historyMessages.length,
      selectedHistoryMessageCount: 0,
      omittedHistoryMessageCount: params.historyMessages.length,
      referenceMessageCount: referenceMessages.length,
      continuationMessageCount: continuationMessages.length,
      attachmentCount: attachments.length,
    });
    if (!params.deferCompactionFailure) {
      throw new Error(
        pinnedProjection.errorCode ??
          "request_context_pinned_content_exceeds_budget",
      );
    }
  }

  const turns = collectConversationTurns(params.historyMessages);
  const selectedTurns: ConversationTurn[] = [];
  let selectedMessageCount = 0;
  let estimatedInputTokens = pinnedTokenEstimate;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const historyIsCompactionManaged =
      params.historyRetention === "compaction_managed";
    const turnTokens = estimateMessagesTokens(
      turn.messages,
      params.budget.tokenEstimation,
    );
    if (
      !historyIsCompactionManaged &&
      estimatedInputTokens + turnTokens > availableInputTokens
    ) {
      break;
    }

    selectedTurns.unshift(turn);
    selectedMessageCount += turn.messages.length;
    estimatedInputTokens += turnTokens;
  }

  const selectedHistoryMessageIds = selectedTurns.flatMap((turn) =>
    turn.source.map((message) => message.id),
  );
  const selectedIds = new Set(selectedHistoryMessageIds);
  const historyMessageIds = params.historyMessages.map((message) => message.id);
  const parts: RequestContextBudgetParts = Object.freeze({
    ...baseParts,
    selectedHistoryInputTokens: estimatedInputTokens - pinnedTokenEstimate,
  });
  const budget = Object.freeze({
    ...pinnedAssessment.budget,
    estimatedInputTokens,
    parts,
  });

  traceRequestContextBudgetAssessment({
    diagnostic: params.diagnostic,
    outcome: "projected",
    budget,
    parts,
    historyMessageCount: params.historyMessages.length,
    selectedHistoryMessageCount: selectedHistoryMessageIds.length,
    omittedHistoryMessageCount:
      historyMessageIds.length - selectedHistoryMessageIds.length,
    referenceMessageCount: referenceMessages.length,
    continuationMessageCount: continuationMessages.length,
    attachmentCount: attachments.length,
  });

  const trailingMessages =
    params.currentMessagePlacement === "after_continuation"
      ? [...continuationMessages, currentMessage]
      : [currentMessage, ...continuationMessages];

  return {
    messages: [
      ...fixedMessages,
      ...selectedTurns.flatMap((turn) => turn.messages),
      ...referenceMessages,
      ...trailingMessages,
    ],
    selectedHistoryMessageIds,
    omittedHistoryMessageIds: historyMessageIds.filter(
      (id) => !selectedIds.has(id),
    ),
    budget,
    compaction: pinnedProjection.compaction,
  };
}

function resolvePinnedParts(params: {
  category: RequestContextPinnedPart["category"];
  legacyMessages?: readonly ChatMessage[];
  parts?: readonly RequestContextPinnedPart[];
}): readonly RequestContextPinnedPart[] {
  const legacyMessages = params.legacyMessages ?? [];
  if (legacyMessages.length > 0 && params.parts !== undefined) {
    throw new Error("request_context_pinned_parts_conflict");
  }
  if (params.parts !== undefined) {
    if (params.parts.some((part) => part.category !== params.category)) {
      throw new Error("request_context_pinned_part_category_invalid");
    }
    return params.parts;
  }
  if (legacyMessages.length === 0) {
    return Object.freeze([]);
  }
  return Object.freeze([
    Object.freeze({
      sourceRef: `legacy:${params.category}`,
      category: params.category,
      retention: "exact" as const,
      messages: Object.freeze([...legacyMessages]),
    }),
  ]);
}

function traceRequestContextBudgetAssessment(params: Readonly<{
  diagnostic?: RequestContextDiagnostic;
  outcome: "projected" | "rejected";
  issueCode?: string;
  budget: RequestContextBudgetEstimate;
  parts: RequestContextBudgetParts;
  historyMessageCount: number;
  selectedHistoryMessageCount: number;
  omittedHistoryMessageCount: number;
  referenceMessageCount: number;
  continuationMessageCount: number;
  attachmentCount: number;
}>): void {
  if (!params.diagnostic) {
    return;
  }
  traceDebug("runtime.context", "budget.assessed", {
    ...params.diagnostic,
    phase: "request_projection",
    outcome: params.outcome,
    fits: params.outcome === "projected",
    issueCode: params.issueCode ?? "",
    ...params.budget,
    ...params.parts,
    historyMessageCount: params.historyMessageCount,
    selectedHistoryMessageCount: params.selectedHistoryMessageCount,
    omittedHistoryMessageCount: params.omittedHistoryMessageCount,
    referenceMessageCount: params.referenceMessageCount,
    continuationMessageCount: params.continuationMessageCount,
    attachmentCount: params.attachmentCount,
  });
}

/** Returns the latest complete visible user-to-assistant turn, if one exists. */
export function projectLatestCompleteConversationTurn(
  historyMessages: readonly RequestHistoryMessage[],
): readonly [RequestHistoryMessage, RequestHistoryMessage] | undefined {
  const turns = collectConversationTurns(historyMessages);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const source = turns[index]!.source;
    if (
      source.length === 2 &&
      source[0]?.role === "user" &&
      source[1]?.role === "assistant"
    ) {
      return Object.freeze([source[0], source[1]]);
    }
  }
  return undefined;
}

function collectConversationTurns(
  historyMessages: readonly RequestHistoryMessage[],
): ConversationTurn[] {
  const visibleMessages = historyMessages.filter(
    (message) =>
      message.grounding !== "tool_observation" &&
      message.content.trim().length > 0,
  );
  const turns: ConversationTurn[] = [];

  for (const message of visibleMessages) {
    if (message.role === "user") {
      turns.push(createConversationTurn(message));
      continue;
    }

    const pendingTurn = findPendingConversationTurn(turns, message);
    if (!pendingTurn) {
      continue;
    }
    pendingTurn.source.push(message);
    pendingTurn.messages.push({
      role: "assistant",
      content: message.content,
    });
  }

  return turns;
}

function createConversationTurn(
  user: RequestHistoryMessage,
  assistant?: RequestHistoryMessage,
): ConversationTurn {
  return {
    source: assistant ? [user, assistant] : [user],
    messages: [
      { role: "user", content: user.content },
      ...(assistant
        ? [{ role: "assistant" as const, content: assistant.content }]
        : []),
    ],
  };
}

function findPendingConversationTurn(
  turns: ConversationTurn[],
  assistant: RequestHistoryMessage,
): ConversationTurn | undefined {
  const pendingTurns = turns.filter((turn) => turn.source.length === 1);
  if (assistant.requestId) {
    const exactMatch = findLastConversationTurn(
      pendingTurns,
      (turn) => turn.source[0]?.requestId === assistant.requestId,
    );
    if (exactMatch) {
      return exactMatch;
    }
    return findLastConversationTurn(
      pendingTurns,
      (turn) => !turn.source[0]?.requestId,
    );
  }
  return pendingTurns.at(-1);
}

function findLastConversationTurn(
  turns: ConversationTurn[],
  predicate: (turn: ConversationTurn) => boolean,
): ConversationTurn | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (predicate(turn)) {
      return turn;
    }
  }
  return undefined;
}
