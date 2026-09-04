import type {
  ConversationActivityInput,
  ConversationContextWindowModel,
} from "./conversation-activity.js";

export type ComposerContextWindowModel = ConversationContextWindowModel & {
  requestId: string;
};

export declare function buildComposerContextWindowModel(options?: {
  messages?: Array<{ role: string; requestId?: unknown }>;
  activeRequestId?: unknown;
  getActivityForMessage?(message: {
    role: string;
    requestId?: unknown;
  }): Pick<ConversationActivityInput, "contextWindow">;
}): ComposerContextWindowModel | null;

export declare function createComposerContextWindow(options: {
  container: HTMLElement;
  documentRoot?: Document;
}): {
  render(model: ComposerContextWindowModel | null): void;
  reset(): void;
};
