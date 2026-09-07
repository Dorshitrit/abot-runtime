import type { createMessageLinkPreviewClient } from "../services/message-link-preview-client.js";

export declare function createMessageLinkPreviews(options?: {
  documentRoot?: Document;
  viewport?: Window & { IntersectionObserver?: typeof IntersectionObserver };
  scrollRoot?: Element | null;
  onLayoutChange?: () => void;
  client?: ReturnType<typeof createMessageLinkPreviewClient>;
}): {
  createNode(message: {
    role?: string;
    text?: string;
    streaming?: boolean;
  }): HTMLElement | null;
  reset(): void;
};
