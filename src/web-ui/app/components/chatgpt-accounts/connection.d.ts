import type { ChatgptAccountRequests, ChatgptAccount } from "../../services/runtime-web-client/chatgpt-accounts.js";
export declare function createChatgptAccountConnection(options: {
  client?: ChatgptAccountRequests; getEnvironmentId?: () => string;
  onChange?: (state: { accountRef: string; ready: boolean; account: ChatgptAccount | null }) => void;
  onModel?: (model: string) => void; openUrl?: (url: string) => void; documentRoot?: Document;
}): {
  mount(root: HTMLElement | null, options?: { accountRef?: string; locked?: boolean; models?: boolean }): void;
  unmount(): void; reset(): void; supported(): boolean;
};
