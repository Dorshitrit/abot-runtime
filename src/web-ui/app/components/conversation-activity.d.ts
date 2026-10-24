import type { MemoryActivity } from "../lib/memory-activity-model.js";
import type { ContextWindowDisplay } from "../lib/context-window-state.js";
import type { ConversationFileReference } from "../lib/conversation-file-reference.js";
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

export type ConversationContextWindowModel = ContextWindowDisplay;

export declare function buildConversationActivityModel(
  input?: ConversationActivityInput,
): {
  requestId: string;
  events: ConversationActivityEvent[];
  memoryActivities: MemoryActivity[];
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
  canOpenFile?: () => boolean;
  onOpenFile?: (
    reference: ConversationFileReference,
    opener: HTMLElement,
  ) => unknown;
}): {
  createNode(input?: ConversationActivityInput): HTMLElement | null;
  forget(requestId: unknown): void;
  reset(): void;
};
