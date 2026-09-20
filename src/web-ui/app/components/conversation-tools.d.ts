import type { ConversationFileReference } from "../lib/conversation-file-reference.js";
import type { ConversationToolAction } from "../lib/tool-activity-model.js";

export declare function createConversationTools(options?: {
  documentRoot?: Document;
  canOpenFile?: () => boolean;
  onOpenFile?: (
    reference: ConversationFileReference,
    opener: HTMLElement,
  ) => unknown;
}): {
  createNode(input?: {
    requestId?: string;
    actions?: ConversationToolAction[];
    embedded?: boolean;
  }): HTMLElement | null;
  forget(requestId: unknown): void;
  reset(): void;
};
