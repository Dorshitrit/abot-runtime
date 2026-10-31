import type { ChatgptAccountRequests, ChatgptAccount, ChatgptAttempt, ChatgptModel } from "../services/runtime-web-client/chatgpt-accounts.js";
export type ChatgptAccountState = { accounts: readonly ChatgptAccount[]; accountRef: string; models: readonly ChatgptModel[]; busy: string; error: string; notice: string; attempt: ChatgptAttempt | null; loaded: boolean };
export declare function createChatgptAccountController(options: {
  client: ChatgptAccountRequests; getEnvironmentId?: () => string; onChange?: () => void; openAuthorization?: (url: string) => void;
  schedule?: typeof setTimeout; unschedule?: typeof clearTimeout; now?: () => number;
}): {
  state: ChatgptAccountState; account(): ChatgptAccount | null; canUseAccount(): boolean;
  load(preferredAccount?: string): Promise<void>; select(accountRef: string): Promise<void>;
  start(purpose?: "sign_in" | "enable_plan_usage", accountRef?: string): Promise<void>;
  retry(): Promise<void>; cancel(): Promise<void>; disconnect(): Promise<void>; acknowledge(): Promise<void>; reset(): void;
};
