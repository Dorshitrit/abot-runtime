type ReasoningMessage = { id: string; thinkingText?: string };

export declare function createConversationReasoning(options?: {
  documentRoot?: Document;
}): {
  beginRender(messages: ReasoningMessage[]): void;
  createNode(message: ReasoningMessage): HTMLDetailsElement | null;
  reset(): void;
};
