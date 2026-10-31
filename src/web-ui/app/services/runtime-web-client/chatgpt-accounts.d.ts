export type ChatgptAccount = Readonly<{
  accountRef: string; label: string; email?: string;
  status: "connected" | "identity_only" | "signed_out" | "reauth_required";
  planEnabled: boolean; planWelcomeAcknowledged: boolean;
}>;
export type ChatgptAttempt = Readonly<{
  attemptId: string; status: "pending" | "complete" | "failed" | "cancelled"; expiresAt: number;
  retryable?: boolean;
  authorizationUrl?: string; accountRef?: string; error?: { code: string; message: string };
}>;
export type ChatgptModel = Readonly<{ id: string; displayName: string; contextWindow?: number }>;
export type ChatgptAccountRequests = {
  supportsChatgptAccounts(): boolean;
  listChatgptAccounts(options?: { signal?: AbortSignal }): Promise<{ ok: true; accounts: readonly ChatgptAccount[] }>;
  startChatgptAttempt(input: { accountRef?: string; purpose: "sign_in" | "enable_plan_usage" }, options?: { signal?: AbortSignal }): Promise<{ ok: true; attempt: ChatgptAttempt }>;
  retryChatgptAttempt(attemptId: string, options?: { signal?: AbortSignal }): Promise<{ ok: true; attempt: ChatgptAttempt }>;
  getChatgptAttempt(attemptId: string, options?: { signal?: AbortSignal }): Promise<{ ok: true; attempt: ChatgptAttempt }>;
  cancelChatgptAttempt(attemptId: string): Promise<unknown>;
  disconnectChatgptAccount(accountRef: string, options?: { signal?: AbortSignal }): Promise<{ ok: true; result: { revocationConfirmed: boolean; message?: string } }>;
  acknowledgeChatgptPlan(accountRef: string, options?: { signal?: AbortSignal }): Promise<{ ok: true; account: ChatgptAccount }>;
  listChatgptModels(accountRef: string, options?: { signal?: AbortSignal }): Promise<{ ok: true; models: readonly ChatgptModel[] }>;
};
export declare function createChatgptAccountRequests(options: {
  requestApi(path: string, options?: RequestInit): Promise<unknown>; getConfig(): { backend?: string } | null;
}): ChatgptAccountRequests;
