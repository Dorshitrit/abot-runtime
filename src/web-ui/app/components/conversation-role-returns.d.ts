import type { RoleReturn } from "../lib/role-return-event.js";

export declare function createConversationRoleReturns(options?: {
  documentRoot?: Document;
}): {
  createNode(input: {
    requestId: string;
    returns?: RoleReturn[];
  }): HTMLElement | null;
  forget(requestId: string): void;
  reset(): void;
};
