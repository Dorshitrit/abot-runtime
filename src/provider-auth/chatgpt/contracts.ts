export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
export type ChatGptPurpose = "sign_in" | "enable_plan_usage";
export type ChatGptAccount = {
  accountRef: string;
  label: string;
  email?: string;
  status: "connected" | "identity_only" | "signed_out" | "reauth_required";
  planEnabled: boolean;
  planWelcomeAcknowledged: boolean;
};
export type ChatGptAttempt = {
  attemptId: string;
  status: "pending" | "complete" | "failed" | "cancelled";
  expiresAt: number;
  authorizationUrl?: string;
  accountRef?: string;
  error?: { code: string; message: string };
  retryable?: boolean;
};
export type ChatGptModel = {
  id: string;
  displayName: string;
  contextWindow?: number;
};
export type ChatGptTokens = {
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  expiresAt: number;
  earliestRefreshAt?: number;
  scopes: string[];
};
export type StoredChatGptAccount = {
  accountRef: string;
  label: string;
  issuer: string;
  subject: string;
  clientId: string;
  email?: string;
  planWelcomeAcknowledged: boolean;
  tokens?: ChatGptTokens;
  reauthRequired?: boolean;
  authorizationRevision?: number;
};
export type ChatGptAccountStore = {
  version: 1;
  hostId: string;
  accounts: StoredChatGptAccount[];
};
export class ChatGptAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
export function requireChatGptAccountRef(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  )
    throw new ChatGptAuthError(
      "chatgpt_account_invalid",
      "Choose a saved ChatGPT account.",
    );
  return value;
}
export function hasPlanPermission(account: StoredChatGptAccount): boolean {
  return account.tokens?.scopes.includes(CHATGPT_PLAN_SCOPE) === true;
}
function accountConnectionStatus(
  account: StoredChatGptAccount,
): ChatGptAccount["status"] {
  if (account.reauthRequired) return "reauth_required";
  if (!account.tokens) return "signed_out";
  return hasPlanPermission(account) ? "connected" : "identity_only";
}
export function safeAccount(account: StoredChatGptAccount): ChatGptAccount {
  return {
    accountRef: account.accountRef,
    label: account.label,
    ...(account.email ? { email: account.email } : {}),
    status: accountConnectionStatus(account),
    planEnabled: hasPlanPermission(account),
    planWelcomeAcknowledged: account.planWelcomeAcknowledged,
  };
}
export function authFailure(error: unknown): ChatGptAuthError {
  if (error instanceof ChatGptAuthError) return error;
  return new ChatGptAuthError(
    "chatgpt_auth_unavailable",
    "ChatGPT connection is unavailable. Try again.",
    503,
  );
}
