export declare function createConversationRoleHistory(options: {
  documentRoot?: Document;
  kind: "delegation" | "return";
  textClassName: string;
  ariaLabel: string;
}): {
  createNode(input: {
    requestId: string;
    items?: { id: string; label: string; text: string }[];
  }): HTMLElement | null;
  forget(requestId: string): void;
  reset(): void;
};
