import { randomUUID } from "node:crypto";
import {
  ChatGptAuthError,
  CHATGPT_ISSUER,
  CHATGPT_RESOURCE,
  type StoredChatGptAccount,
} from "./contracts.js";
import {
  ChatGptStore,
  storedAccount,
  accountAuthorizationRevision,
  requireAccountAuthorizationRevision,
} from "./account-store.js";
import { ChatGptIdentity } from "./discovery.js";
import { ChatGptTransport } from "./transport.js";
import { readTokenResponse } from "./token-response.js";

export type RegistrationRequest = {
  accountRef?: string;
  authorizationRevision?: number;
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  nonce: string;
  signal: AbortSignal;
  beginCommit(): void;
};
function hasSelectedIdentity(
  previous: StoredChatGptAccount | undefined,
  subject: string | undefined,
  issuer: string | undefined,
  clientId: string,
): boolean {
  if (!previous) return true;
  if (previous.subject !== subject) return false;
  if (previous.issuer !== issuer) return false;
  return previous.clientId === clientId;
}
export async function completeChatGptRegistration(
  store: ChatGptStore,
  transport: ChatGptTransport,
  identity: ChatGptIdentity,
  now: () => number,
  request: RegistrationRequest,
): Promise<string> {
  const metadata = await identity.discovery(request.signal);
  return store.transaction(async (value) => {
    const previous = request.accountRef
      ? storedAccount(value, request.accountRef)
      : undefined;
    if (previous)
      requireAccountAuthorizationRevision(
        previous,
        request.authorizationRevision ?? 0,
      );
    const response = await transport.form(
      metadata.token_endpoint,
      {
        grant_type: "authorization_code",
        client_id: request.clientId,
        code: request.code,
        code_verifier: request.verifier,
        redirect_uri: request.redirectUri,
        resource: CHATGPT_RESOURCE,
      },
      request.signal,
    );
    const tokens = readTokenResponse(response, now());
    const claims = await identity.verify(
      tokens.idToken,
      request.clientId,
      request.nonce,
      request.signal,
    );
    if (
      !hasSelectedIdentity(previous, claims.sub, claims.iss, request.clientId)
    )
      throw new ChatGptAuthError(
        "chatgpt_account_mismatch",
        "The signed-in identity does not match the selected account.",
      );
    request.signal.throwIfAborted();
    const existing =
      previous ??
      value.accounts.find(
        (entry) =>
          entry.issuer === CHATGPT_ISSUER &&
          entry.subject === claims.sub &&
          entry.clientId === request.clientId,
      );
    const email =
      typeof claims.email === "string" && claims.email.length <= 320
        ? claims.email
        : undefined;
    const accountRef = existing?.accountRef ?? randomUUID();
    const account: StoredChatGptAccount = {
      accountRef,
      label:
        existing?.label ??
        (email ?? "ChatGPT account") + " · " + accountRef.slice(0, 8),
      issuer: CHATGPT_ISSUER,
      subject: claims.sub!,
      clientId: request.clientId,
      ...(email ? { email } : {}),
      tokens,
      planWelcomeAcknowledged: existing?.planWelcomeAcknowledged ?? false,
      authorizationRevision: existing
        ? accountAuthorizationRevision(existing)
        : 0,
    };
    if (existing) value.accounts[value.accounts.indexOf(existing)] = account;
    else value.accounts.push(account);
    request.beginCommit();
    return accountRef;
  });
}
