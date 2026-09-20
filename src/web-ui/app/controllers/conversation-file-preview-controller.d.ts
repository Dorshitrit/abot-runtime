import type { FilePreviewViewState } from "../components/conversation-file-preview.js";
export type { FilePreviewViewState } from "../components/conversation-file-preview.js";
import type { ConversationFileReference } from "../lib/conversation-file-reference.js";
import type { ConversationFileClient } from "../services/runtime-web-client/conversation-files.js";
export interface ConversationFileScope {
  environmentId: string;
  sessionId: string;
  activeRequestId?: string;
}
export declare function filePreviewErrorMessage(error: unknown): string;
export declare function createConversationFilePreviewController(options: {
  client: ConversationFileClient;
  getScope: () => ConversationFileScope;
  render: (state: FilePreviewViewState) => void;
  AbortControllerImpl?: typeof AbortController;
}): {
  open(
    reference: ConversationFileReference,
    opener?: HTMLElement,
  ): Promise<void>;
  openNative(): Promise<void>;
  close(options?: { restoreFocus?: boolean }): void;
  syncScope(): void;
};
