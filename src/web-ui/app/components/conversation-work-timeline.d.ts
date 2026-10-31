import type { CreateProjectFileChanges } from "../controllers/project-file-changes-feature.js";
import type { ConversationActivityInput, buildConversationActivityModel } from "./conversation-activity.js";
import type { ConversationFileReference } from "../lib/conversation-file-reference.js";

export type ConversationWorkTimelineInput = ConversationActivityInput & {
  updates?: Record<string, unknown>[];
  hasFinalAnswer?: boolean;
  summaryModel?: ReturnType<typeof buildConversationActivityModel>;
};

export declare function createConversationWorkTimeline(options?: {
  documentRoot?: Document;
  canOpenFile?: () => boolean;
  createFileChanges?: CreateProjectFileChanges;
  onVisibilityChange?(): void;
  onOpenFile?: (reference: ConversationFileReference, opener: HTMLElement) => unknown;
}): {
  createNode(input?: ConversationWorkTimelineInput): HTMLElement | null;
  forget(requestId: unknown): void;
  reset(): void;
  handlesProgressUpdates: true;
};
