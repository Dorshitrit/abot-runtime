import { vi } from "vitest";
import type { ChatgptAccount, ChatgptAccountRequests, ChatgptAttempt } from "../../../web-ui/app/services/runtime-web-client/chatgpt-accounts.js";
export const connectedChatgptAccount: ChatgptAccount = {
  accountRef: "registration-a", label: "Personal", email: "same@example.test",
  status: "connected", planEnabled: true, planWelcomeAcknowledged: true,
};
export function chatgptUiClient(accounts: ChatgptAccount[] = [connectedChatgptAccount]) {
  return {
    supportsChatgptAccounts: vi.fn(() => true),
    listChatgptAccounts: vi.fn(async () => ({ ok: true as const, accounts })),
    listChatgptModels: vi.fn(async () => ({ ok: true as const, models: [{ id: "z-model", displayName: "Z" }, { id: "a-model", displayName: "A" }] })),
    startChatgptAttempt: vi.fn(async (): Promise<{ ok: true; attempt: ChatgptAttempt }> => ({ ok: true as const, attempt: {
      attemptId: "attempt-a", status: "pending" as const, expiresAt: Date.now() + 60_000,
      authorizationUrl: "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client",
    } })),
    retryChatgptAttempt: vi.fn(async () => ({ ok: true as const, attempt: { attemptId: "retry-a", status: "pending" as const, expiresAt: Date.now() + 60_000 } })),
    getChatgptAttempt: vi.fn(async (): Promise<{ ok: true; attempt: ChatgptAttempt }> => ({ ok: true as const, attempt: { attemptId: "attempt-a", status: "complete" as const, expiresAt: Date.now() + 60_000, accountRef: accounts[0]?.accountRef } })),
    cancelChatgptAttempt: vi.fn(async () => ({})),
    disconnectChatgptAccount: vi.fn(async () => ({ ok: true as const, result: { revocationConfirmed: true } })),
    acknowledgeChatgptPlan: vi.fn(async () => ({ ok: true as const, account: { ...accounts[0]!, planWelcomeAcknowledged: true } })),
  } satisfies ChatgptAccountRequests;
}
export function pendingChatgptResult<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
