import type {
  ChatMessage,
  ModelFormatTokenAccountingConfig,
  ModelTokenEstimationConfig,
} from "../../model-gateway/types.js";
import type { SessionMessageGrounding } from "../../sessions/types.js";

export type RequestHistoryMessage = Readonly<{
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  requestId?: string;
  grounding?: SessionMessageGrounding;
}>;

export type RequestContextBudget = Readonly<{
  contextWindowTokens: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
  attachmentReserveTokens: number;
  /** Configured methodology not yet present during early context projection. */
  configuredInstructionReserveTokens?: number;
  formatTokenAccounting?: ModelFormatTokenAccountingConfig;
  tokenEstimation?: ModelTokenEstimationConfig;
}>;

export type RequestContextPinnedPartCategory =
  | "request_reference"
  | "role_continuation";

export type RequestContextPinnedPart = Readonly<{
  sourceRef: string;
  category: RequestContextPinnedPartCategory;
  retention: "exact" | "compactable";
  messages: readonly ChatMessage[];
  compactMessages?: readonly ChatMessage[];
}>;

export type RequestContextBudgetEstimate = Readonly<{
  contextWindowTokens: number;
  availableInputTokens: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
  configuredInstructionReserveTokens?: number;
  formatReserveTokens: number;
  attachmentReserveTokens: number;
  estimatedInputTokens: number;
  /** Exact preflight count when the selected provider exposes that capability. */
  measuredInputTokens?: number;
  remainingContextTokens: number;
  usedContextPercent: number;
  compactionTriggerInputTokens: number;
}>;

export type RequestContextBudgetParts = Readonly<{
  instructionInputTokens: number;
  priorConversationInputTokens: number;
  referenceInputTokens: number;
  currentPromptInputTokens: number;
  continuationInputTokens: number;
  selectedHistoryInputTokens: number;
  pinnedInputTokens: number;
}>;

export type RequestContextProjection = Readonly<{
  messages: ChatMessage[];
  selectedHistoryMessageIds: string[];
  omittedHistoryMessageIds: string[];
  budget: RequestContextBudgetEstimate & {
    parts: RequestContextBudgetParts;
  };
  compaction: Readonly<{
    applied: boolean;
    compactedSourceRefs: readonly string[];
  }>;
}>;
