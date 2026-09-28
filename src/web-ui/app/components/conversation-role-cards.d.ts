import type { ConversationFileReference } from "../lib/conversation-file-reference.js";
import type { buildConversationRoleCards } from "../lib/conversation-role-model.js";

export declare function createConversationRoleCards(options?: {
  documentRoot?: Document;
  canOpenFile?: () => boolean;
  onOpenFile?: (
    reference: ConversationFileReference,
    opener: HTMLElement,
  ) => unknown;
}): {
  createNode(input: {
    requestId: string;
    cards: ReturnType<typeof buildConversationRoleCards>;
    heading?: HTMLElement;
    timeline: HTMLElement;
    hasTimeline: boolean;
    onViewChange?: () => void;
  }): HTMLElement;
  isTimeline(requestId: string): boolean;
  forget(requestId: string): void;
  reset(): void;
};
