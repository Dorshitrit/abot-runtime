import type { ConversationFilePreview } from "../lib/conversation-file-preview.js";
export interface FilePreviewViewState {
  open: boolean;
  restoreFocus?: boolean;
  status?: "loading" | "ready" | "error" | "native";
  opener?: HTMLElement;
  name?: string;
  file?: ConversationFilePreview;
  nativeStatus?: "opening" | "opened" | "error";
  nativeError?: string;
  imageUrl?: string;
  error?: string;
}
export declare function createConversationFilePreview(options: {
  host: HTMLElement;
  documentRoot?: Document;
  viewport?: Window;
  onClose: () => void;
  onOpenNative?: () => void | Promise<void>;
}): {
  render(state: FilePreviewViewState): void;
  panel: HTMLElement;
};
