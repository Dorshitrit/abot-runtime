import type { ChatgptAccountRequests } from "../../services/runtime-web-client/chatgpt-accounts.js";
export declare function createChatgptAccountSettings(options: { root: HTMLElement; client: ChatgptAccountRequests; getEnvironmentId(): string }): { open(accountRef?: string): boolean; close(): void; isOpen(): boolean };
