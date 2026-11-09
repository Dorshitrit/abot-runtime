type ReasoningMessage = { id: string; thinkingText?: string };

export declare function createConversationReasoning(options?: {
  documentRoot?: Document;
}): {
  beginRender(messages: ReasoningMessage[]): void;
  createNode(message: ReasoningMessage, options?: { allowEmpty?: boolean }): HTMLDetailsElement | null;
  update(messages: ReasoningMessage[]): boolean;
  reset(): void;
};
