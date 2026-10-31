import type { ChatgptAccountState } from "../../controllers/chatgpt-account-controller.js";
export declare const CHATGPT_USAGE_URL: string;
export declare function chatgptAuthorizationUrl(value: unknown): string;
export declare function renderChatgptAccounts(state: ChatgptAccountState, options?: { locked?: boolean; models?: boolean }): string;
