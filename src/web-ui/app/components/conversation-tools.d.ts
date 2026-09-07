import type { ConversationToolAction } from "../lib/tool-activity-model.js";

export declare function createConversationTools(options?: {
  documentRoot?: Document;
}): {
  createNode(input?: {
    requestId?: string;
    actions?: ConversationToolAction[];
    embedded?: boolean;
  }): HTMLElement | null;
  forget(requestId: unknown): void;
  reset(): void;
};
