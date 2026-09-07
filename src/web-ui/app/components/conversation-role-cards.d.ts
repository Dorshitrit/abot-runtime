import type { buildConversationRoleCards } from "../lib/conversation-role-model.js";

export declare function createConversationRoleCards(options?: {
  documentRoot?: Document;
}): {
  createSummaryNode(
    cards: ReturnType<typeof buildConversationRoleCards>,
  ): HTMLElement | null;
  createNode(input: {
    requestId: string;
    cards: ReturnType<typeof buildConversationRoleCards>;
    timeline: HTMLElement;
    hasTimeline: boolean;
    onViewChange?: () => void;
  }): HTMLElement;
  isTimeline(requestId: string): boolean;
  bindScroll(input: {
    requestId: string;
    body: HTMLElement;
    details: HTMLDetailsElement;
  }): () => boolean;
  forget(requestId: string): void;
  reset(): void;
};
