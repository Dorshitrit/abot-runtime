import type { RoleDelegation } from "../lib/role-delegation-event.js";

export declare function createConversationRoleDelegations(options?: {
  documentRoot?: Document;
}): {
  createNode(input: {
    requestId: string;
    delegations?: RoleDelegation[];
  }): HTMLElement | null;
  forget(requestId: string): void;
  reset(): void;
};
