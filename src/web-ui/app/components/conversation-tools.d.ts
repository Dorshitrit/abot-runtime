import type { CreateProjectFileChanges } from "../controllers/project-file-changes-feature.js";
import type { ConversationFileReference } from "../lib/conversation-file-reference.js";
import type { ConversationToolAction } from "../lib/tool-activity-model.js";

export declare function createConversationTools(options?: {
  documentRoot?: Document;
  canOpenFile?: () => boolean;
  createFileChanges?: CreateProjectFileChanges;
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
