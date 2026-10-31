export declare function projectConversationInteractionEntries<T extends Record<string, unknown>>(
  messages: readonly T[],
): Array<{ message: T; updates: T[] }>;

export declare function createConversationInteraction(options: {
  documentRoot?: Document;
}): {
  createNode(updates: Record<string, unknown>[]): HTMLElement | null;
};
