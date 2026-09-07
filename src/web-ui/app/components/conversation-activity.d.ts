import type { buildConversationRoleCards } from "../lib/conversation-role-model.js";
import type { ConversationSourcesGroup } from "../lib/web-sources.js";
import type { ConversationToolAction } from "../lib/tool-activity-model.js";

export type ConversationActivityInput = {
  requestId?: unknown;
  events?: unknown[];
  taskProgress?: unknown;
  contextWindow?: unknown;
  streaming?: boolean;
};

export type ConversationActivityEvent = Record<string, unknown> & {
  eventName: string;
  name: string;
  tone: string;
};

export type ConversationContextWindowModel = {
  invocationId: string;
  modelStep: string;
  profileId: string;
  measurement: string;
  source: string;
  admissionOutcome: string;
  contextWindowTokens: number;
  estimatedInputTokens: number;
  remainingContextTokens: number;
  usedContextPercent: number;
  remainingContextPercent: number;
  compactionTriggerPercent: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
  attachmentReserveTokens: number;
  formatReserveTokens: number;
  providerUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    source: string;
  } | null;
  compaction: {
    beforePercent: number;
    afterPercent: number;
  } | null;
};

export declare function buildConversationActivityModel(
  input?: ConversationActivityInput,
): {
  requestId: string;
  events: ConversationActivityEvent[];
  roleCards: ReturnType<typeof buildConversationRoleCards>;
  sources: ConversationSourcesGroup[];
  toolActions: ConversationToolAction[];
  progress: unknown;
  contextWindow: ConversationContextWindowModel | null;
  eventCount: number;
  toolCount: number;
  failureCount: number;
  latestLabel: string;
  currentLabel: string;
  openByDefault: boolean;
  hasContent: boolean;
};

export declare function pinConversationActivityToLatest(input?: {
  details?: { open: boolean };
  body?: { scrollTop: number; scrollHeight: number };
  streaming?: boolean;
}): boolean;

export declare function createConversationActivity(options?: {
  documentRoot?: Document;
}): {
  createNode(input?: ConversationActivityInput): HTMLElement | null;
  forget(requestId: unknown): void;
  reset(): void;
};
