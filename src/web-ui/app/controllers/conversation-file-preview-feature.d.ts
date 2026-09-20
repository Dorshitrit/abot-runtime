import type { ConversationFileReference } from "../lib/conversation-file-reference.js";
import type { ConversationFileClient } from "../services/runtime-web-client/conversation-files.js";
import type { ConversationFileScope } from "./conversation-file-preview-controller.js";
export declare function createConversationFilePreviewFeature(options: {
  client?: ConversationFileClient;
  getScope: () => ConversationFileScope;
  scrollRoot: HTMLElement;
  documentRoot: Document;
  viewport: Window;
}): {
  canOpen(): boolean;
  open?: (
    reference: ConversationFileReference,
    opener?: HTMLElement,
  ) => Promise<void>;
  reset(): void;
  syncScope(): void;
  setWorkspace(workspace: string): void;
};
